import { Hono } from 'hono';
import {
    findUserByEmail, findUserById, setEmailVerified, updatePasswordBumpVersion,
    createAuthToken, consumeAuthToken, countRecentAuthTokens, cleanExpiredAuthTokens,
    recordOtpFailure,
} from '../lib/db.ts';
import { hashPassword, verifyPassword } from '../lib/crypto.ts';
import { authMiddleware, mintAuthResponse } from '../middleware/auth.ts';
import type { AuthPayload } from '../middleware/auth.ts';
import { generateToken, generateOtp, otpHash, sha256Hex, TOKEN_TTL_SECONDS } from '../lib/tokens.ts';
import { sendVerificationEmail, sendPasswordResetEmail, sendOtpEmail } from '../lib/email.ts';
import { verifyTurnstile } from '../lib/turnstile.ts';
import { logAuthEvent } from '../lib/log.ts';
import type { AppEnv } from '../types.ts';

export const authEmailRouter = new Hono<AppEnv>();

// ─── Email verification ─────────────────────────────────────

authEmailRouter.post('/v1/auth/verify', async (c) => {
    const { token } = await c.req.json<{ token?: string }>();
    if (typeof token !== 'string' || !token) {
        return c.json({ error: 'invalid_token' }, 400);
    }
    const db = c.env.arcane_db;
    const row = await consumeAuthToken(db, 'verify_email', await sha256Hex(token));
    if (!row) {
        return c.json({ error: 'invalid_token' }, 400);
    }
    const user = await setEmailVerified(db, row.user_id);
    if (!user) {
        return c.json({ error: 'invalid_token' }, 400);
    }
    logAuthEvent('email_verified', { userId: user.id });
    // Fresh JWT so the website can immediately replace its stored token with
    // one whose email_verified claim is current.
    return c.json(await mintAuthResponse(user, c.env.JWT_SECRET));
});

authEmailRouter.post('/v1/auth/resend-verification', authMiddleware(), async (c) => {
    const authUser = c.get('user') as AuthPayload;
    const db = c.env.arcane_db;
    const user = await findUserById(db, parseInt(authUser.sub));
    if (!user) {
        return c.json({ error: 'User not found' }, 404);
    }
    if (user.email_verified === 1) {
        return c.json({ ok: true });
    }
    if (await countRecentAuthTokens(db, user.id, 'verify_email') >= 3) {
        return c.json({ error: 'resend_throttled' }, 429);
    }
    const rawToken = generateToken();
    await createAuthToken(db, {
        userId: user.id, purpose: 'verify_email',
        tokenHash: await sha256Hex(rawToken), ttlSeconds: TOKEN_TTL_SECONDS.verify_email,
    });
    c.executionCtx.waitUntil(sendVerificationEmail(c.env, user.email, rawToken));
    logAuthEvent('verification_resent', { userId: user.id });
    return c.json({ ok: true });
});

// ─── Passwordless sign-in (emailed one-time code) ───────────

// Login-only, never login-or-register. This endpoint is unauthenticated and
// wired to the send_email binding, so auto-registering would let anyone mint
// users rows for arbitrary addresses AND make no-reply@arcaneai.org send to
// them — a spam-relay vector against the domain's sending reputation. New
// users go through /v1/auth/signup.
authEmailRouter.post('/v1/auth/otp/request', async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const email = body.email;
    // Always-200 on the account-existence axis: no enumeration oracle.
    const ok = () => c.json({ ok: true });
    const turnstileOk = await verifyTurnstile(
        c.env.TURNSTILE_SECRET,
        (body['cf-turnstile-response'] ?? body.turnstileToken) as string | undefined,
        c.req.header('CF-Connecting-IP'),
    );
    if (!turnstileOk) {
        return c.json({ error: 'turnstile_failed' }, 400);
    }
    if (typeof email !== 'string' || !email) {
        return ok();
    }
    const db = c.env.arcane_db;
    await cleanExpiredAuthTokens(db);
    const user = await findUserByEmail(db, email);
    if (!user) {
        return ok();
    }
    // Silent throttle — still {ok:true} so throttling can't be probed either.
    if (await countRecentAuthTokens(db, user.id, 'otp_login') >= 3) {
        return ok();
    }
    const code = generateOtp();
    await createAuthToken(db, {
        userId: user.id, purpose: 'otp_login',
        tokenHash: await otpHash(user.id, code), ttlSeconds: TOKEN_TTL_SECONDS.otp_login,
    });
    c.executionCtx.waitUntil(sendOtpEmail(c.env, user.email, code));
    logAuthEvent('otp_requested', { userId: user.id });
    return ok();
});

authEmailRouter.post('/v1/auth/otp/verify', async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const { email, code } = body as { email?: unknown; code?: unknown };
    // One rejection for every failure mode — unknown account, wrong code,
    // expired, replayed, burnt by too many guesses. Telling them apart would
    // hand an attacker both an account oracle and a progress meter.
    const reject = () => c.json({ error: 'invalid_code' }, 400);
    if (typeof email !== 'string' || typeof code !== 'string' || !email || !code) {
        return reject();
    }
    const db = c.env.arcane_db;
    const user = await findUserByEmail(db, email);
    if (!user) {
        return reject();
    }
    const row = await consumeAuthToken(db, 'otp_login', await otpHash(user.id, code));
    if (!row) {
        await recordOtpFailure(db, user.id);
        logAuthEvent('otp_failed', { userId: user.id });
        return reject();
    }
    // Receiving a code sent to that address proves ownership, the same
    // reasoning the Google path uses when it sets email_verified on link.
    const verified = user.email_verified === 1 ? user : (await setEmailVerified(db, user.id) ?? user);
    logAuthEvent('otp_login', { userId: user.id });
    return c.json(await mintAuthResponse(verified, c.env.JWT_SECRET));
});

// ─── Password reset ─────────────────────────────────────────

authEmailRouter.post('/v1/auth/forgot', async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const email = body.email;
    // Always-200 on the account-existence axis: no enumeration oracle.
    const ok = () => c.json({ ok: true });
    const turnstileOk = await verifyTurnstile(
        c.env.TURNSTILE_SECRET,
        (body['cf-turnstile-response'] ?? body.turnstileToken) as string | undefined,
        c.req.header('CF-Connecting-IP'),
    );
    if (!turnstileOk) {
        return c.json({ error: 'turnstile_failed' }, 400);
    }
    if (typeof email !== 'string' || !email) {
        return ok();
    }
    const db = c.env.arcane_db;
    await cleanExpiredAuthTokens(db);
    const user = await findUserByEmail(db, email);
    if (!user) {
        return ok();
    }
    // Silent throttle — still {ok:true} so throttling can't be probed either.
    if (await countRecentAuthTokens(db, user.id, 'password_reset') >= 3) {
        return ok();
    }
    const rawToken = generateToken();
    await createAuthToken(db, {
        userId: user.id, purpose: 'password_reset',
        tokenHash: await sha256Hex(rawToken), ttlSeconds: TOKEN_TTL_SECONDS.password_reset,
    });
    c.executionCtx.waitUntil(sendPasswordResetEmail(c.env, user.email, rawToken));
    logAuthEvent('forgot_password', { userId: user.id });
    return ok();
});

authEmailRouter.post('/v1/auth/reset', async (c) => {
    const { token, newPassword } = await c.req.json<{ token?: string; newPassword?: string }>();
    if (typeof token !== 'string' || !token) {
        return c.json({ error: 'invalid_token' }, 400);
    }
    // Validate BEFORE consuming so a typo doesn't burn the one-time token.
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
        return c.json({ error: 'weak_password' }, 400);
    }
    const db = c.env.arcane_db;
    const row = await consumeAuthToken(db, 'password_reset', await sha256Hex(token));
    if (!row) {
        return c.json({ error: 'invalid_token' }, 400);
    }
    const { hash, salt } = await hashPassword(newPassword);
    // Bumps token_version → every existing session is signed out.
    const updated = await updatePasswordBumpVersion(db, row.user_id, hash, salt);
    if (!updated) {
        return c.json({ error: 'invalid_token' }, 400);
    }
    // Completing a reset proves email ownership (works for Google-only users
    // setting their first password too).
    const user = (await setEmailVerified(db, updated.id))!;
    logAuthEvent('password_reset', { userId: user.id });
    return c.json(await mintAuthResponse(user, c.env.JWT_SECRET));
});

authEmailRouter.post('/v1/auth/change-password', authMiddleware(), async (c) => {
    const { currentPassword, newPassword } = await c.req.json<{
        currentPassword?: string; newPassword?: string;
    }>();
    const authUser = c.get('user') as AuthPayload;
    const db = c.env.arcane_db;
    const user = await findUserById(db, parseInt(authUser.sub));
    if (!user) {
        return c.json({ error: 'User not found' }, 404);
    }
    if (user.password_hash === '') {
        // Google-only account: no password to change. The website's "set
        // password" path is the forgot→reset flow.
        return c.json({ error: 'no_password_set' }, 400);
    }
    if (typeof currentPassword !== 'string'
        || !(await verifyPassword(currentPassword, user.password_hash, user.salt))) {
        return c.json({ error: 'invalid_credentials' }, 401);
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
        return c.json({ error: 'weak_password' }, 400);
    }
    const { hash, salt } = await hashPassword(newPassword);
    const updated = (await updatePasswordBumpVersion(db, user.id, hash, salt))!;
    logAuthEvent('password_changed', { userId: user.id });
    // token_version just bumped — hand back a valid session for THIS client.
    return c.json(await mintAuthResponse(updated, c.env.JWT_SECRET));
});
