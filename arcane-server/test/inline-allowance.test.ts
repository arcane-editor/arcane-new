import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { incrementInlineUsage, addInlineSpend } from '../src/lib/db.ts';
import { seedPasswordUser } from './helpers.ts';
import { checkInlineAllowance, utcDateKey, nextUtcMidnight, utcMonthKey, nextUtcMonth } from '../src/lib/inline-allowance.ts';
import { INLINE_DAILY_CAP, INLINE_MONTHLY_MICRO_CEILING } from '../src/config/tiers.ts';

async function setPlan(userId: number, plan: string) {
    await env.arcane_db.prepare('UPDATE users SET plan = ? WHERE id = ?').bind(plan, userId).run();
}

describe('incrementInlineUsage', () => {
    it('starts at 1, increments atomically, and is per-day', async () => {
        const user = await seedPasswordUser('inline-ctr@test.dev', 'password123');
        expect(await incrementInlineUsage(env.arcane_db, user.id, '2026-08-03')).toBe(1);
        expect(await incrementInlineUsage(env.arcane_db, user.id, '2026-08-03')).toBe(2);
        expect(await incrementInlineUsage(env.arcane_db, user.id, '2026-08-04')).toBe(1);
    });
});

describe('checkInlineAllowance', () => {
    it('UTC date helpers', () => {
        const t = new Date('2026-08-03T23:59:00Z');
        expect(utcDateKey(t)).toBe('2026-08-03');
        expect(nextUtcMidnight(t)).toBe('2026-08-04T00:00:00.000Z');
    });

    it('caps are per spec — free is a feature lock (0), not a quota', () => {
        expect(INLINE_DAILY_CAP).toEqual({ free: 0, starter: 300, pro: 1500, max: 3000 });
    });

    it('allows under the cap, rejects over it with inline_quota + resetAt', async () => {
        const user = await seedPasswordUser('inline-cap@test.dev', 'password123');
        await setPlan(user.id, 'starter');
        // Pre-load today's counter to the starter cap so the NEXT call tips over.
        await env.arcane_db.prepare(
            'INSERT INTO inline_usage (user_id, usage_date, count) VALUES (?, ?, ?)'
        ).bind(user.id, utcDateKey(), INLINE_DAILY_CAP.starter - 1).run();

        const under = await checkInlineAllowance(env.arcane_db, user.id);
        expect(under).toMatchObject({ ok: true, count: INLINE_DAILY_CAP.starter });

        const over = await checkInlineAllowance(env.arcane_db, user.id);
        expect(over.ok).toBe(false);
        expect(!over.ok && over.code).toBe('inline_quota');
        if (!over.ok && over.code === 'inline_quota') {
            expect(over.status).toBe(429);
            expect(Date.parse(over.resetAt)).toBeGreaterThan(Date.now());
        }
    });
});

// Free (and any unrecognised plan) never reaches the daily/monthly checks at
// all — INLINE_DAILY_CAP[plan] === 0 is a feature lock, gated first and
// before any counter bump.
describe('checkInlineAllowance — free plan is feature-locked', () => {
    it('403 inline_not_available with requiredPlan starter, no counter bump', async () => {
        const user = await seedPasswordUser('inline-free-locked@test.dev', 'password123'); // free by default
        const result = await checkInlineAllowance(env.arcane_db, user.id);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.status).toBe(403);
            expect(result.code).toBe('inline_not_available');
            expect(result).toMatchObject({ requiredPlan: 'starter' });
        }

        const dailyRow = await env.arcane_db.prepare(
            'SELECT count FROM inline_usage WHERE user_id = ? AND usage_date = ?'
        ).bind(user.id, utcDateKey()).first<{ count: number }>();
        expect(dailyRow).toBeNull(); // no counter bump
    });

    it('an unrecognised plan value is also locked out', async () => {
        const user = await seedPasswordUser('inline-unknown-plan@test.dev', 'password123');
        await setPlan(user.id, 'enterprise');
        const result = await checkInlineAllowance(env.arcane_db, user.id);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.code).toBe('inline_not_available');
    });
});

describe('utcMonthKey', () => {
    it('formats as YYYY-MM', () => {
        expect(utcMonthKey(new Date('2026-08-14T23:59:59Z'))).toBe('2026-08');
    });
});

describe('monthly ceiling', () => {
    const NOW = new Date('2026-08-14T12:00:00Z');

    it('allows a paid user under budget', async () => {
        const user = await seedPasswordUser('inline-ceiling-under@test.dev', 'password123');
        await setPlan(user.id, 'starter');
        const r = await checkInlineAllowance(env.arcane_db, user.id, NOW);
        expect(r.ok).toBe(true);
    });

    it('blocks with 402 once the month budget is spent', async () => {
        const user = await seedPasswordUser('inline-ceiling-over@test.dev', 'password123');
        await setPlan(user.id, 'starter');
        await addInlineSpend(env.arcane_db, user.id, utcMonthKey(NOW), INLINE_MONTHLY_MICRO_CEILING.starter);
        const r = await checkInlineAllowance(env.arcane_db, user.id, NOW);
        expect(r.ok).toBe(false);
        expect(!r.ok && r.code).toBe('inline_budget_exhausted');
        if (!r.ok && r.code === 'inline_budget_exhausted') {
            expect(r.status).toBe(402);
            expect(r.resetAt).toBe(nextUtcMonth(NOW));
        }
    });

    it('the ceiling is checked before the daily counter is incremented', async () => {
        // A user at their monthly ceiling must not have a daily slot consumed.
        const user = await seedPasswordUser('inline-ceiling-order@test.dev', 'password123');
        await setPlan(user.id, 'starter');
        await addInlineSpend(env.arcane_db, user.id, utcMonthKey(NOW), INLINE_MONTHLY_MICRO_CEILING.starter);
        const first = await checkInlineAllowance(env.arcane_db, user.id, NOW);
        const second = await checkInlineAllowance(env.arcane_db, user.id, NOW);
        expect(first.ok).toBe(false);
        expect(second.ok).toBe(false);

        const dailyRow = await env.arcane_db.prepare(
            'SELECT count FROM inline_usage WHERE user_id = ? AND usage_date = ?'
        ).bind(user.id, utcDateKey(NOW)).first<{ count: number }>();
        expect(dailyRow).toBeNull();
    });

    it('nextUtcMonth rolls the year over in December', () => {
        expect(nextUtcMonth(new Date('2026-12-31T23:00:00Z'))).toBe('2027-01-01T00:00:00.000Z');
    });
});
