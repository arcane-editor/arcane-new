import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { generateOtp, otpHash } from '../src/lib/tokens.ts';
import { seedPasswordUser, jsonPost } from './helpers.ts';

/** Reaches past the hash to learn the code under test — the server only ever
 *  stores sha256(userId:code), so tests must plant a known code themselves. */
async function plantOtp(userId: number, code: string, opts: { ttlSeconds?: number } = {}): Promise<void> {
    // SQLite wants a signed modifier ("-1 seconds"), not "+-1 seconds".
    const ttl = opts.ttlSeconds ?? 600;
    await env.arcane_db.prepare(
        `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
         VALUES (?, 'otp_login', ?, datetime('now', ?))`
    ).bind(userId, await otpHash(userId, code), `${ttl >= 0 ? '+' : ''}${ttl} seconds`).run();
}

async function attemptsFor(userId: number): Promise<number> {
    const row = await env.arcane_db.prepare(
        "SELECT attempts FROM auth_tokens WHERE user_id = ? AND purpose = 'otp_login' ORDER BY id DESC LIMIT 1"
    ).bind(userId).first<{ attempts: number }>();
    return row!.attempts;
}

describe('generateOtp', () => {
    it('always returns exactly 6 digits, zero-padded', () => {
        for (let i = 0; i < 500; i++) {
            expect(generateOtp()).toMatch(/^\d{6}$/);
        }
    });

    it('spreads across the range rather than repeating', () => {
        const seen = new Set(Array.from({ length: 200 }, () => generateOtp()));
        expect(seen.size).toBeGreaterThan(190);
    });
});

describe('otpHash', () => {
    it('binds the code to the user — same code, different user, different hash', async () => {
        expect(await otpHash(1, '123456')).not.toBe(await otpHash(2, '123456'));
    });
});

describe('POST /v1/auth/otp/request', () => {
    it('returns {ok:true} for an unknown email without minting a code', async () => {
        const res = await jsonPost('/v1/auth/otp/request', { email: 'ghost@otp.dev' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        const stray = await env.arcane_db.prepare(
            "SELECT COUNT(*) AS n FROM auth_tokens WHERE purpose = 'otp_login'"
        ).first<{ n: number }>();
        expect(stray!.n).toBe(0);
    });

    it('mints a code for a known email', async () => {
        const user = await seedPasswordUser('req@otp.dev', 'password123');
        expect((await jsonPost('/v1/auth/otp/request', { email: 'req@otp.dev' })).status).toBe(200);
        const row = await env.arcane_db.prepare(
            "SELECT COUNT(*) AS n FROM auth_tokens WHERE user_id = ? AND purpose = 'otp_login'"
        ).bind(user.id).first<{ n: number }>();
        expect(row!.n).toBe(1);
    });

    it('silently throttles after 3 requests in an hour', async () => {
        await seedPasswordUser('throttle@otp.dev', 'password123');
        for (let i = 0; i < 3; i++) {
            expect((await jsonPost('/v1/auth/otp/request', { email: 'throttle@otp.dev' })).status).toBe(200);
        }
        const fourth = await jsonPost('/v1/auth/otp/request', { email: 'throttle@otp.dev' });
        expect(fourth.status).toBe(200);
        expect(await fourth.json()).toEqual({ ok: true });
    });
});

describe('POST /v1/auth/otp/verify', () => {
    it('exchanges a correct code for a session JWT', async () => {
        const user = await seedPasswordUser('ok@otp.dev', 'password123');
        await plantOtp(user.id, '123456');
        const res = await jsonPost('/v1/auth/otp/verify', { email: 'ok@otp.dev', code: '123456' });
        expect(res.status).toBe(200);
        const body = await res.json<{ token: string; user: { email: string } }>();
        expect(body.token).toBeTruthy();
        expect(body.user.email).toBe('ok@otp.dev');
    });

    it('marks the email verified — receiving the code proves ownership', async () => {
        const user = await seedPasswordUser('unv@otp.dev', 'password123', { verified: false });
        await plantOtp(user.id, '222222');
        const res = await jsonPost('/v1/auth/otp/verify', { email: 'unv@otp.dev', code: '222222' });
        expect(res.status).toBe(200);
        expect((await res.json<{ user: { emailVerified: boolean } }>()).user.emailVerified).toBe(true);
    });

    it('rejects a wrong code and counts the attempt', async () => {
        const user = await seedPasswordUser('wrong@otp.dev', 'password123');
        await plantOtp(user.id, '333333');
        const res = await jsonPost('/v1/auth/otp/verify', { email: 'wrong@otp.dev', code: '999999' });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'invalid_code' });
        expect(await attemptsFor(user.id)).toBe(1);
    });

    it('destroys the code after 5 wrong attempts, so the right one no longer works', async () => {
        const user = await seedPasswordUser('bruteforce@otp.dev', 'password123');
        await plantOtp(user.id, '444444');
        for (let i = 0; i < 5; i++) {
            expect((await jsonPost('/v1/auth/otp/verify',
                { email: 'bruteforce@otp.dev', code: '000000' })).status).toBe(400);
        }
        const correct = await jsonPost('/v1/auth/otp/verify', { email: 'bruteforce@otp.dev', code: '444444' });
        expect(correct.status).toBe(400);
    });

    it('refuses one user’s code on another user’s account', async () => {
        const victim = await seedPasswordUser('victim@otp.dev', 'password123');
        await seedPasswordUser('attacker@otp.dev', 'password123');
        await plantOtp(victim.id, '555555');
        const res = await jsonPost('/v1/auth/otp/verify', { email: 'attacker@otp.dev', code: '555555' });
        expect(res.status).toBe(400);
    });

    it('rejects a replayed code', async () => {
        const user = await seedPasswordUser('replay@otp.dev', 'password123');
        await plantOtp(user.id, '666666');
        expect((await jsonPost('/v1/auth/otp/verify', { email: 'replay@otp.dev', code: '666666' })).status).toBe(200);
        const replay = await jsonPost('/v1/auth/otp/verify', { email: 'replay@otp.dev', code: '666666' });
        expect(replay.status).toBe(400);
    });

    it('rejects an expired code', async () => {
        const user = await seedPasswordUser('expired@otp.dev', 'password123');
        await plantOtp(user.id, '777777', { ttlSeconds: -1 });
        const res = await jsonPost('/v1/auth/otp/verify', { email: 'expired@otp.dev', code: '777777' });
        expect(res.status).toBe(400);
    });

    it('gives an unknown email the same rejection as a wrong code', async () => {
        const res = await jsonPost('/v1/auth/otp/verify', { email: 'nobody@otp.dev', code: '123456' });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'invalid_code' });
    });
});
