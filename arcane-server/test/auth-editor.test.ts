import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { generateToken, s256Challenge, sha256Hex } from '../src/lib/tokens.ts';
import { seedPasswordUser, tokenFor, jsonPost } from './helpers.ts';

async function grantCode(): Promise<{ code: string; verifier: string; jwt: string }> {
    const user = await seedPasswordUser(`ed-${crypto.randomUUID()}@test.dev`, 'password123');
    const jwt = await tokenFor(user);
    const verifier = generateToken();
    const challenge = await s256Challenge(verifier);
    const res = await jsonPost('/v1/auth/editor/grant', { challenge }, jwt);
    expect(res.status).toBe(200);
    const body = await res.json<{ code: string; expires_in: number }>();
    expect(body.expires_in).toBe(60);
    expect(body.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    return { code: body.code, verifier, jwt };
}

describe('POST /v1/auth/editor/grant', () => {
    it('requires a Bearer token', async () => {
        const res = await jsonPost('/v1/auth/editor/grant', { challenge: 'x'.repeat(43) });
        expect(res.status).toBe(401);
    });

    it('rejects malformed challenges (not base64url 43-128)', async () => {
        const user = await seedPasswordUser('edbad@test.dev', 'password123');
        const jwt = await tokenFor(user);
        for (const challenge of ['short', 'x'.repeat(129), `${'A'.repeat(42)}+`, '']) {
            const res = await jsonPost('/v1/auth/editor/grant', { challenge }, jwt);
            expect(res.status).toBe(400);
            expect(await res.json()).toEqual({ error: 'invalid_challenge' });
        }
    });
});

describe('POST /v1/auth/editor/exchange', () => {
    it('exchanges code+verifier for a full session', async () => {
        const { code, verifier } = await grantCode();
        const res = await jsonPost('/v1/auth/editor/exchange', { code, verifier });
        expect(res.status).toBe(200);
        const body = await res.json<{ token: string; user: { id: number } }>();
        expect(body.token).toBeTruthy();
        // the minted JWT works on a Bearer route
        const me = await jsonPost('/v1/auth/resend-verification', {}, body.token);
        expect(me.status).toBe(200);
    });

    it('rejects a replayed code (opaque invalid_code)', async () => {
        const { code, verifier } = await grantCode();
        expect((await jsonPost('/v1/auth/editor/exchange', { code, verifier })).status).toBe(200);
        const replay = await jsonPost('/v1/auth/editor/exchange', { code, verifier });
        expect(replay.status).toBe(400);
        expect(await replay.json()).toEqual({ error: 'invalid_code' });
    });

    it('rejects a wrong verifier — and the code is burned by the attempt', async () => {
        const { code } = await grantCode();
        const wrong = await jsonPost('/v1/auth/editor/exchange', { code, verifier: generateToken() });
        expect(wrong.status).toBe(400);
        expect(await wrong.json()).toEqual({ error: 'invalid_code' });
    });

    it('rejects an expired code (opaque invalid_code)', async () => {
        const user = await seedPasswordUser('edexp@test.dev', 'password123');
        const verifier = generateToken();
        const challenge = await s256Challenge(verifier);
        const raw = generateToken();
        // The CODE's own 60s life has lapsed even though the attempt itself is
        // still live — the exchange path must enforce the stricter of the two.
        await env.arcane_db.prepare(
            `INSERT INTO editor_attempts
             (attempt_id, challenge, status, user_id, code_hash, code_expires_at, expires_at)
             VALUES (?, ?, 'authorized', ?, ?, datetime('now', '-10 seconds'), datetime('now', '+9 minutes'))`
        ).bind(crypto.randomUUID(), challenge, user.id, await sha256Hex(raw)).run();
        const res = await jsonPost('/v1/auth/editor/exchange', { code: raw, verifier });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'invalid_code' });
    });

    it('rejects missing fields with the same opaque error', async () => {
        expect((await jsonPost('/v1/auth/editor/exchange', { code: 'x' })).status).toBe(400);
        expect((await jsonPost('/v1/auth/editor/exchange', { verifier: 'x' })).status).toBe(400);
    });
});
