import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createAuthToken } from '../src/lib/db.ts';
import { generateToken, sha256Hex, TOKEN_TTL_SECONDS } from '../src/lib/tokens.ts';
import { seedPasswordUser, seedGoogleOnlyUser, tokenFor, jsonPost } from './helpers.ts';

async function seedToken(userId: number, purpose: 'verify_email' | 'password_reset'): Promise<string> {
    const raw = generateToken();
    await createAuthToken(env.arcane_db, {
        userId, purpose, tokenHash: await sha256Hex(raw), ttlSeconds: TOKEN_TTL_SECONDS[purpose],
    });
    return raw;
}

describe('POST /v1/auth/verify', () => {
    it('consumes a valid token, verifies the user, returns a fresh JWT', async () => {
        const user = await seedPasswordUser('verify@test.dev', 'password123', { verified: false });
        const raw = await seedToken(user.id, 'verify_email');
        const res = await jsonPost('/v1/auth/verify', { token: raw });
        expect(res.status).toBe(200);
        const body = await res.json<{ token: string; user: { emailVerified: boolean } }>();
        expect(body.user.emailVerified).toBe(true);
        expect(body.token).toBeTruthy();
        // fresh JWT works against a Bearer route
        const me = await jsonPost('/v1/auth/resend-verification', {}, body.token);
        expect(me.status).toBe(200); // authed fine (already verified → plain ok)
    });

    it('rejects replay and garbage tokens with invalid_token', async () => {
        const user = await seedPasswordUser('verify2@test.dev', 'password123', { verified: false });
        const raw = await seedToken(user.id, 'verify_email');
        expect((await jsonPost('/v1/auth/verify', { token: raw })).status).toBe(200);
        const replay = await jsonPost('/v1/auth/verify', { token: raw });
        expect(replay.status).toBe(400);
        expect(await replay.json()).toEqual({ error: 'invalid_token' });
        expect((await jsonPost('/v1/auth/verify', { token: 'nope' })).status).toBe(400);
    });
});

describe('POST /v1/auth/resend-verification', () => {
    it('requires auth, creates a token, throttles after 3/hour', async () => {
        const user = await seedPasswordUser('resend@test.dev', 'password123', { verified: false });
        const token = await tokenFor(user);
        expect((await jsonPost('/v1/auth/resend-verification', {}, undefined)).status).toBe(401);
        for (let i = 0; i < 3; i++) {
            const res = await jsonPost('/v1/auth/resend-verification', {}, token);
            expect(res.status).toBe(200);
        }
        const throttled = await jsonPost('/v1/auth/resend-verification', {}, token);
        expect(throttled.status).toBe(429);
        expect(await throttled.json()).toEqual({ error: 'resend_throttled' });
    });

    it('is a no-op {ok:true} for already-verified users', async () => {
        const user = await seedPasswordUser('resend-v@test.dev', 'password123');
        const res = await jsonPost('/v1/auth/resend-verification', {}, await tokenFor(user));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        const n = await env.arcane_db.prepare(
            "SELECT COUNT(*) AS n FROM auth_tokens WHERE user_id = ?"
        ).bind(user.id).first<{ n: number }>();
        expect(n!.n).toBe(0);
    });
});

describe('POST /v1/auth/forgot', () => {
    it('always returns {ok:true}, creating a token only for known emails', async () => {
        const user = await seedPasswordUser('forgot@test.dev', 'password123');
        const unknown = await jsonPost('/v1/auth/forgot', { email: 'nobody@test.dev' });
        expect(unknown.status).toBe(200);
        expect(await unknown.json()).toEqual({ ok: true });

        const known = await jsonPost('/v1/auth/forgot', { email: 'forgot@test.dev' });
        expect(known.status).toBe(200);
        const n = await env.arcane_db.prepare(
            "SELECT COUNT(*) AS n FROM auth_tokens WHERE user_id = ? AND purpose = 'password_reset'"
        ).bind(user.id).first<{ n: number }>();
        expect(n!.n).toBe(1);
    });
});

describe('POST /v1/auth/reset', () => {
    it('sets the new password, revokes old sessions, verifies email, returns fresh JWT', async () => {
        const user = await seedPasswordUser('reset@test.dev', 'oldpassword1', { verified: false });
        const oldJwt = await tokenFor(user);
        const raw = await seedToken(user.id, 'password_reset');

        const res = await jsonPost('/v1/auth/reset', { token: raw, newPassword: 'newpassword1' });
        expect(res.status).toBe(200);
        const body = await res.json<{ token: string; user: { emailVerified: boolean } }>();
        expect(body.user.emailVerified).toBe(true);

        // old session revoked (token_version bumped)
        const stale = await jsonPost('/v1/auth/resend-verification', {}, oldJwt);
        expect(stale.status).toBe(401);
        // new password logs in
        const login = await jsonPost('/v1/auth/login', { email: 'reset@test.dev', password: 'newpassword1' });
        expect(login.status).toBe(200);
        // reset token is single-use
        const replay = await jsonPost('/v1/auth/reset', { token: raw, newPassword: 'anotherpass1' });
        expect(replay.status).toBe(400);
    });

    it('rejects weak passwords without consuming the token', async () => {
        const user = await seedPasswordUser('reset2@test.dev', 'oldpassword1');
        const raw = await seedToken(user.id, 'password_reset');
        const res = await jsonPost('/v1/auth/reset', { token: raw, newPassword: 'short' });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'weak_password' });
        expect((await jsonPost('/v1/auth/reset', { token: raw, newPassword: 'longenough1' })).status).toBe(200);
    });
});

describe('POST /v1/auth/change-password', () => {
    it('changes the password with the current one and revokes other sessions', async () => {
        const user = await seedPasswordUser('chg@test.dev', 'oldpassword1');
        const jwt = await tokenFor(user);
        const res = await jsonPost('/v1/auth/change-password',
            { currentPassword: 'oldpassword1', newPassword: 'newpassword1' }, jwt);
        expect(res.status).toBe(200);
        const body = await res.json<{ token: string }>();
        expect(body.token).toBeTruthy();
        expect((await jsonPost('/v1/auth/change-password',
            { currentPassword: 'x', newPassword: 'y' }, jwt)).status).toBe(401); // old jwt dead
    });

    it('401 invalid_credentials on wrong current password', async () => {
        const user = await seedPasswordUser('chg2@test.dev', 'oldpassword1');
        const res = await jsonPost('/v1/auth/change-password',
            { currentPassword: 'wrongpass1', newPassword: 'newpassword1' }, await tokenFor(user));
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'invalid_credentials' });
    });

    it('400 no_password_set for Google-only accounts', async () => {
        const user = await seedGoogleOnlyUser('gonly@test.dev', 'sub-chg');
        const res = await jsonPost('/v1/auth/change-password',
            { currentPassword: 'x', newPassword: 'newpassword1' }, await tokenFor(user));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'no_password_set' });
    });
});
