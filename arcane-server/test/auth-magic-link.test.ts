import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createAuthToken } from '../src/lib/db.ts';
import { generateToken, sha256Hex, TOKEN_TTL_SECONDS } from '../src/lib/tokens.ts';
import { seedPasswordUser, jsonPost } from './helpers.ts';

async function tokenRowsFor(userId: number, purpose: string): Promise<number> {
    const row = await env.arcane_db.prepare(
        'SELECT COUNT(*) AS n FROM auth_tokens WHERE user_id = ? AND purpose = ?'
    ).bind(userId, purpose).first<{ n: number }>();
    return row!.n;
}

async function emailVerifiedFor(userId: number): Promise<number> {
    const row = await env.arcane_db.prepare(
        'SELECT email_verified FROM users WHERE id = ?'
    ).bind(userId).first<{ email_verified: number }>();
    return row!.email_verified;
}

describe('POST /v1/auth/magic/request', () => {
    it('returns {ok:true} for an unknown email without minting a token', async () => {
        const res = await jsonPost('/v1/auth/magic/request', { email: 'ghost@test.dev' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        const stray = await env.arcane_db.prepare(
            "SELECT COUNT(*) AS n FROM auth_tokens WHERE purpose = 'magic_login'"
        ).first<{ n: number }>();
        expect(stray!.n).toBe(0);
    });

    it('mints a magic_login token for a known email', async () => {
        const user = await seedPasswordUser('magic@test.dev', 'password123');
        const res = await jsonPost('/v1/auth/magic/request', { email: 'magic@test.dev' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        expect(await tokenRowsFor(user.id, 'magic_login')).toBe(1);
    });

    it('matches the email case-insensitively, as login does', async () => {
        const user = await seedPasswordUser('mixedcase@test.dev', 'password123');
        const res = await jsonPost('/v1/auth/magic/request', { email: 'MixedCase@Test.dev' });
        expect(res.status).toBe(200);
        expect(await tokenRowsFor(user.id, 'magic_login')).toBe(1);
    });

    it('silently throttles after 3 requests in an hour', async () => {
        const user = await seedPasswordUser('throttle@test.dev', 'password123');
        for (let i = 0; i < 3; i++) {
            const res = await jsonPost('/v1/auth/magic/request', { email: 'throttle@test.dev' });
            expect(res.status).toBe(200);
        }
        const fourth = await jsonPost('/v1/auth/magic/request', { email: 'throttle@test.dev' });
        // Still {ok:true} — throttling must not be probeable either.
        expect(fourth.status).toBe(200);
        expect(await fourth.json()).toEqual({ ok: true });
        expect(await tokenRowsFor(user.id, 'magic_login')).toBe(3);
    });

    it('returns {ok:true} for a missing or non-string email', async () => {
        expect((await jsonPost('/v1/auth/magic/request', {})).status).toBe(200);
        expect((await jsonPost('/v1/auth/magic/request', { email: 42 })).status).toBe(200);
    });
});

describe('POST /v1/auth/web/exchange — magic_login', () => {
    async function seedMagicToken(userId: number): Promise<string> {
        const raw = generateToken();
        await createAuthToken(env.arcane_db, {
            userId, purpose: 'magic_login',
            tokenHash: await sha256Hex(raw), ttlSeconds: TOKEN_TTL_SECONDS.magic_login,
        });
        return raw;
    }

    it('exchanges a magic_login code for a session JWT', async () => {
        const user = await seedPasswordUser('exchange@test.dev', 'password123');
        const raw = await seedMagicToken(user.id);
        const res = await jsonPost('/v1/auth/web/exchange', { code: raw });
        expect(res.status).toBe(200);
        const body = await res.json<{ token: string; user: { email: string } }>();
        expect(body.token).toBeTruthy();
        expect(body.user.email).toBe('exchange@test.dev');
    });

    it('marks the email verified — clicking the link proves ownership', async () => {
        const user = await seedPasswordUser('unverified@test.dev', 'password123', { verified: false });
        expect(await emailVerifiedFor(user.id)).toBe(0);
        const raw = await seedMagicToken(user.id);
        const res = await jsonPost('/v1/auth/web/exchange', { code: raw });
        expect(res.status).toBe(200);
        const body = await res.json<{ user: { emailVerified: boolean } }>();
        expect(body.user.emailVerified).toBe(true);
        expect(await emailVerifiedFor(user.id)).toBe(1);
    });

    it('rejects a replayed magic_login code', async () => {
        const user = await seedPasswordUser('replay@test.dev', 'password123');
        const raw = await seedMagicToken(user.id);
        expect((await jsonPost('/v1/auth/web/exchange', { code: raw })).status).toBe(200);
        const replay = await jsonPost('/v1/auth/web/exchange', { code: raw });
        expect(replay.status).toBe(400);
        expect(await replay.json()).toEqual({ error: 'invalid_code' });
    });

    it('still exchanges a web_login code — Google handoff must not regress', async () => {
        const user = await seedPasswordUser('google-path@test.dev', 'password123');
        const raw = generateToken();
        await createAuthToken(env.arcane_db, {
            userId: user.id, purpose: 'web_login',
            tokenHash: await sha256Hex(raw), ttlSeconds: TOKEN_TTL_SECONDS.web_login,
        });
        const res = await jsonPost('/v1/auth/web/exchange', { code: raw });
        expect(res.status).toBe(200);
        expect((await res.json<{ token: string }>()).token).toBeTruthy();
    });
});
