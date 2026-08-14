import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { incrementInlineUsage } from '../src/lib/db.ts';
import { seedPasswordUser } from './helpers.ts';
import { checkInlineAllowance, utcDateKey, nextUtcMidnight } from '../src/lib/inline-allowance.ts';
import { INLINE_DAILY_CAP } from '../src/config/tiers.ts';

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
