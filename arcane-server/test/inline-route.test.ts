import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { seedPasswordUser, tokenFor, jsonPost } from './helpers.ts';
import { INLINE_DAILY_CAP } from '../src/config/tiers.ts';
import { utcDateKey } from '../src/lib/inline-allowance.ts';

const GOOD_BODY = { prefix: 'int x = ', suffix: ';', language: 'csharp' };

describe('POST /v1/completions/inline', () => {
    it('401 without a token', async () => {
        const res = await jsonPost('/v1/completions/inline', GOOD_BODY);
        expect(res.status).toBe(401);
    });

    it('403 for unverified email', async () => {
        const user = await seedPasswordUser('inl-unv@test.dev', 'password123', { verified: false });
        const res = await jsonPost('/v1/completions/inline', GOOD_BODY, await tokenFor(user));
        expect(res.status).toBe(403);
    });

    it('400 inline_bad_request for missing fields and invalid JSON', async () => {
        const user = await seedPasswordUser('inl-bad@test.dev', 'password123');
        const token = await tokenFor(user);
        const res = await jsonPost('/v1/completions/inline', { prefix: 'a' }, token);
        expect(res.status).toBe(400);
        expect((await res.json() as { code: string }).code).toBe('inline_bad_request');

        const raw = await SELF.fetch('https://example.com/v1/completions/inline', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: 'not json',
        });
        expect(raw.status).toBe(400);
    });

    it('413 inline_too_large for oversized bodies', async () => {
        const user = await seedPasswordUser('inl-big@test.dev', 'password123');
        const res = await jsonPost('/v1/completions/inline',
            { ...GOOD_BODY, prefix: 'x'.repeat(40_000) }, await tokenFor(user));
        expect(res.status).toBe(413);
        expect((await res.json() as { code: string }).code).toBe('inline_too_large');
    });

    it('413 inline_too_large measures UTF-8 bytes, not UTF-16 code units', async () => {
        // Each '中' is 1 UTF-16 code unit but 3 UTF-8 bytes: 12,000 chars is
        // under the 32*1024 = 32,768 code-unit count but over it in bytes
        // (36,000). A .length-based guard would wrongly let this through.
        const user = await seedPasswordUser('inl-cjk@test.dev', 'password123');
        const prefix = '中'.repeat(12_000);
        expect(prefix.length).toBeLessThan(32 * 1024);
        const res = await jsonPost('/v1/completions/inline',
            { ...GOOD_BODY, prefix }, await tokenFor(user));
        expect(res.status).toBe(413);
        expect((await res.json() as { code: string }).code).toBe('inline_too_large');
    });

    it('429 inline_quota with resetAt once the daily cap is hit', async () => {
        const user = await seedPasswordUser('inl-q@test.dev', 'password123');
        await env.arcane_db.prepare(
            'INSERT INTO inline_usage (user_id, usage_date, count) VALUES (?, ?, ?)'
        ).bind(user.id, utcDateKey(), INLINE_DAILY_CAP.free).run();
        const res = await jsonPost('/v1/completions/inline', GOOD_BODY, await tokenFor(user));
        expect(res.status).toBe(429);
        const body = await res.json() as { code: string; resetAt: string };
        expect(body.code).toBe('inline_quota');
        expect(Date.parse(body.resetAt)).toBeGreaterThan(Date.now());
    });

    it('503 inline_unavailable when the AI binding is absent (test env)', async () => {
        const user = await seedPasswordUser('inl-ok@test.dev', 'password123');
        const res = await jsonPost('/v1/completions/inline', GOOD_BODY, await tokenFor(user));
        expect(res.status).toBe(503);
        expect((await res.json() as { code: string }).code).toBe('inline_unavailable');
    });
});
