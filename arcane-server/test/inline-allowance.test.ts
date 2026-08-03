import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { incrementInlineUsage } from '../src/lib/db.ts';
import { seedPasswordUser } from './helpers.ts';

describe('incrementInlineUsage', () => {
    it('starts at 1, increments atomically, and is per-day', async () => {
        const user = await seedPasswordUser('inline-ctr@test.dev', 'password123');
        expect(await incrementInlineUsage(env.arcane_db, user.id, '2026-08-03')).toBe(1);
        expect(await incrementInlineUsage(env.arcane_db, user.id, '2026-08-03')).toBe(2);
        expect(await incrementInlineUsage(env.arcane_db, user.id, '2026-08-04')).toBe(1);
    });
});
