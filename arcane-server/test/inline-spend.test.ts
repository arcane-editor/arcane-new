import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { addInlineSpend, getInlineSpend } from '../src/lib/db.ts';

describe('inline spend accumulator', () => {
    it('starts at zero', async () => {
        expect(await getInlineSpend(env.arcane_db, 9001, '2026-08')).toBe(0);
    });

    it('accumulates and returns the running total', async () => {
        expect(await addInlineSpend(env.arcane_db, 9002, '2026-08', 100)).toBe(100);
        expect(await addInlineSpend(env.arcane_db, 9002, '2026-08', 55)).toBe(155);
        expect(await getInlineSpend(env.arcane_db, 9002, '2026-08')).toBe(155);
    });

    it('scopes by month', async () => {
        await addInlineSpend(env.arcane_db, 9003, '2026-08', 500);
        expect(await getInlineSpend(env.arcane_db, 9003, '2026-09')).toBe(0);
    });
});
