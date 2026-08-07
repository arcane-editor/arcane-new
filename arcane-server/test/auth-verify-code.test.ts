import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { otpHash } from '../src/lib/tokens.ts';
import { seedPasswordUser, tokenFor, jsonPost } from './helpers.ts';

/** The server only ever stores sha256(userId:code), so tests plant a known one. */
async function plantCode(userId: number, code: string, opts: { ttlSeconds?: number } = {}): Promise<void> {
    const ttl = opts.ttlSeconds ?? 900;
    await env.arcane_db.prepare(
        `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
         VALUES (?, 'verify_email', ?, datetime('now', ?))`
    ).bind(userId, await otpHash(userId, code), `${ttl >= 0 ? '+' : ''}${ttl} seconds`).run();
}

async function codeRowsFor(userId: number): Promise<number> {
    const row = await env.arcane_db.prepare(
        "SELECT COUNT(*) AS n FROM auth_tokens WHERE user_id = ? AND purpose = 'verify_email'"
    ).bind(userId).first<{ n: number }>();
    return row!.n;
}

async function attemptsFor(userId: number): Promise<number> {
    const row = await env.arcane_db.prepare(
        "SELECT attempts FROM auth_tokens WHERE user_id = ? AND purpose = 'verify_email' ORDER BY id DESC LIMIT 1"
    ).bind(userId).first<{ attempts: number }>();
    return row!.attempts;
}

describe('POST /v1/auth/signup', () => {
    it('mints exactly one verify_email code for the new account', async () => {
        const res = await jsonPost('/v1/auth/signup', { email: 'newbie@code.dev', password: 'password123' });
        expect(res.status).toBe(200);
        const body = await res.json<{ token: string; user: { id: number; emailVerified: boolean } }>();
        // Signed in immediately, but unverified — AI routes stay gated until
        // the code is entered.
        expect(body.user.emailVerified).toBe(false);
        expect(await codeRowsFor(body.user.id)).toBe(1);
    });
});

describe('POST /v1/auth/verify', () => {
    it('verifies the account with the emailed code and returns a fresh JWT', async () => {
        const user = await seedPasswordUser('verify@code.dev', 'password123', { verified: false });
        await plantCode(user.id, '135790');
        const res = await jsonPost('/v1/auth/verify', { code: '135790' }, await tokenFor(user));
        expect(res.status).toBe(200);
        const body = await res.json<{ token: string; user: { emailVerified: boolean } }>();
        expect(body.user.emailVerified).toBe(true);
        expect(body.token).toBeTruthy();
    });

    it('requires authentication — the code alone is not enough', async () => {
        const user = await seedPasswordUser('noauth@code.dev', 'password123', { verified: false });
        await plantCode(user.id, '246800');
        const res = await jsonPost('/v1/auth/verify', { code: '246800' });
        expect(res.status).toBe(401);
    });

    it('rejects a wrong code and counts the attempt', async () => {
        const user = await seedPasswordUser('wrong@code.dev', 'password123', { verified: false });
        await plantCode(user.id, '111111');
        const res = await jsonPost('/v1/auth/verify', { code: '999999' }, await tokenFor(user));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'invalid_code' });
        expect(await attemptsFor(user.id)).toBe(1);
    });

    it('destroys the code after 5 wrong attempts, so the right one no longer works', async () => {
        const user = await seedPasswordUser('brute@code.dev', 'password123', { verified: false });
        await plantCode(user.id, '222222');
        const jwt = await tokenFor(user);
        for (let i = 0; i < 5; i++) {
            expect((await jsonPost('/v1/auth/verify', { code: '000000' }, jwt)).status).toBe(400);
        }
        expect((await jsonPost('/v1/auth/verify', { code: '222222' }, jwt)).status).toBe(400);
    });

    it('refuses another account’s code', async () => {
        const victim = await seedPasswordUser('victim@code.dev', 'password123', { verified: false });
        const attacker = await seedPasswordUser('attacker@code.dev', 'password123', { verified: false });
        await plantCode(victim.id, '333333');
        const res = await jsonPost('/v1/auth/verify', { code: '333333' }, await tokenFor(attacker));
        expect(res.status).toBe(400);
    });

    it('rejects a replayed code', async () => {
        const user = await seedPasswordUser('replay@code.dev', 'password123', { verified: false });
        await plantCode(user.id, '444444');
        const jwt = await tokenFor(user);
        expect((await jsonPost('/v1/auth/verify', { code: '444444' }, jwt)).status).toBe(200);
        expect((await jsonPost('/v1/auth/verify', { code: '444444' }, jwt)).status).toBe(400);
    });

    it('rejects an expired code', async () => {
        const user = await seedPasswordUser('expired@code.dev', 'password123', { verified: false });
        await plantCode(user.id, '555555', { ttlSeconds: -1 });
        const res = await jsonPost('/v1/auth/verify', { code: '555555' }, await tokenFor(user));
        expect(res.status).toBe(400);
    });
});

describe('POST /v1/auth/resend-verification', () => {
    it('mints a fresh code', async () => {
        const user = await seedPasswordUser('resend@code.dev', 'password123', { verified: false });
        const res = await jsonPost('/v1/auth/resend-verification', {}, await tokenFor(user));
        expect(res.status).toBe(200);
        expect(await codeRowsFor(user.id)).toBe(1);
    });
});

describe('sign-in by code is gone', () => {
    it('no longer exposes the OTP sign-in routes', async () => {
        expect((await jsonPost('/v1/auth/otp/request', { email: 'x@y.dev' })).status).toBe(404);
        expect((await jsonPost('/v1/auth/otp/verify', { email: 'x@y.dev', code: '123456' })).status).toBe(404);
    });
});
