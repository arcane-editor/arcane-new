import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { incrementInlineUsage, addInlineSpend } from '../src/lib/db.ts';
import { seedPasswordUser } from './helpers.ts';
import { checkInlineAllowance, utcDateKey, nextUtcMidnight, utcMonthKey, nextUtcMonth } from '../src/lib/inline-allowance.ts';
import { INLINE_DAILY_CAP, INLINE_MONTHLY_MICRO_CEILING } from '../src/config/tiers.ts';

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

    it('caps are per spec', () => {
        // Task 2: each plan's monthly inline budget divided by 30.
        expect(INLINE_DAILY_CAP).toEqual({ free: 600, pro: 1200, proplus: 3000, ultra: 12000 });
    });

    it('allows under the cap, rejects over it with inline_quota + resetAt', async () => {
        const user = await seedPasswordUser('inline-cap@test.dev', 'password123');
        // Pre-load today's counter to the free cap so the NEXT call tips over.
        await env.arcane_db.prepare(
            'INSERT INTO inline_usage (user_id, usage_date, count) VALUES (?, ?, ?)'
        ).bind(user.id, utcDateKey(), INLINE_DAILY_CAP.free - 1).run();

        const under = await checkInlineAllowance(env.arcane_db, user.id);
        expect(under).toMatchObject({ ok: true, count: INLINE_DAILY_CAP.free });

        const over = await checkInlineAllowance(env.arcane_db, user.id);
        expect(over.ok).toBe(false);
        if (!over.ok) {
            expect(over.status).toBe(429);
            expect(over.code).toBe('inline_quota');
            expect(Date.parse(over.resetAt)).toBeGreaterThan(Date.now());
        }
    });
});

describe('utcMonthKey', () => {
    it('formats as YYYY-MM', () => {
        expect(utcMonthKey(new Date('2026-08-14T23:59:59Z'))).toBe('2026-08');
    });
});

describe('monthly ceiling', () => {
    const NOW = new Date('2026-08-14T12:00:00Z');

    it('allows a user under budget', async () => {
        const user = await seedPasswordUser('inline-ceiling-under@test.dev', 'password123');
        const r = await checkInlineAllowance(env.arcane_db, user.id, NOW);
        expect(r.ok).toBe(true);
    });

    it('blocks with 402 once the month budget is spent', async () => {
        const user = await seedPasswordUser('inline-ceiling-over@test.dev', 'password123');
        await addInlineSpend(env.arcane_db, user.id, utcMonthKey(NOW), INLINE_MONTHLY_MICRO_CEILING.free);
        const r = await checkInlineAllowance(env.arcane_db, user.id, NOW);
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.status).toBe(402);
            expect(r.code).toBe('inline_budget_exhausted');
            expect(r.resetAt).toBe(nextUtcMonth(NOW));
        }
    });

    it('the ceiling is checked before the daily counter is incremented', async () => {
        // A user at their monthly ceiling must not have a daily slot consumed.
        const user = await seedPasswordUser('inline-ceiling-order@test.dev', 'password123');
        await addInlineSpend(env.arcane_db, user.id, utcMonthKey(NOW), INLINE_MONTHLY_MICRO_CEILING.free);
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
