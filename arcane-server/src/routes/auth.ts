import { Hono } from 'hono';
import {
    findUserByEmail, findUserById, createUser,
    findCurrentUsagePeriod, getCurrentPeriodStart,
    createDeviceCode, findDeviceCodeByDeviceCode,
    authorizeDeviceCode, deleteDeviceCode, cleanExpiredDeviceCodes,
    createAuthToken,
} from '../lib/db.ts';
import { hashPassword, verifyPassword } from '../lib/crypto.ts';
import { authMiddleware, mintAuthResponse, makeUserResponse } from '../middleware/auth.ts';
import type { AuthPayload } from '../middleware/auth.ts';
import { generateToken, sha256Hex, TOKEN_TTL_SECONDS } from '../lib/tokens.ts';
import { sendVerificationEmail } from '../lib/email.ts';
import { verifyTurnstile } from '../lib/turnstile.ts';
import { logAuthEvent } from '../lib/log.ts';
import type { AppEnv } from '../types.ts';

export const authRouter = new Hono<AppEnv>();

// ─── Helpers ────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function generateUserCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    for (let i = 0; i < 8; i++) {
        code += chars[bytes[i]! % chars.length];
        if (i === 3) { code += '-'; }
    }
    return code;
}

// ─── Signup / Login ─────────────────────────────────────────

authRouter.post('/v1/auth/signup', async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const { email, password } = body;

    if (!email || !password) {
        return c.json({ error: 'Email and password required' }, 400);
    }
    if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
        return c.json({ error: 'invalid_email' }, 400);
    }
    if (typeof password !== 'string' || password.length < 8) {
        return c.json({ error: 'weak_password' }, 400);
    }
    const turnstileOk = await verifyTurnstile(
        c.env.TURNSTILE_SECRET,
        (body['cf-turnstile-response'] ?? body.turnstileToken) as string | undefined,
        c.req.header('CF-Connecting-IP'),
    );
    if (!turnstileOk) {
        return c.json({ error: 'turnstile_failed' }, 400);
    }

    const db = c.env.arcane_db;

    const existing = await findUserByEmail(db, email);
    if (existing) {
        if (existing.password_hash === '') {
            // Accepted enumeration trade-off: tell them to use Google.
            return c.json({ error: 'google_account' }, 409);
        }
        return c.json({ error: 'Email already registered' }, 409);
    }

    const { hash, salt } = await hashPassword(password);
    const user = await createUser(db, { email, passwordHash: hash, salt });

    const rawToken = generateToken();
    await createAuthToken(db, {
        userId: user.id, purpose: 'verify_email',
        tokenHash: await sha256Hex(rawToken), ttlSeconds: TOKEN_TTL_SECONDS.verify_email,
    });
    c.executionCtx.waitUntil(sendVerificationEmail(c.env, user.email, rawToken));
    logAuthEvent('signup', { userId: user.id });

    return c.json(await mintAuthResponse(user, c.env.JWT_SECRET));
});

authRouter.post('/v1/auth/login', async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const { email, password } = body;

    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
        return c.json({ error: 'Email and password required' }, 400);
    }
    const turnstileOk = await verifyTurnstile(
        c.env.TURNSTILE_SECRET,
        (body['cf-turnstile-response'] ?? body.turnstileToken) as string | undefined,
        c.req.header('CF-Connecting-IP'),
    );
    if (!turnstileOk) {
        return c.json({ error: 'turnstile_failed' }, 400);
    }

    const db = c.env.arcane_db;

    const user = await findUserByEmail(db, email);
    if (!user) {
        return c.json({ error: 'Invalid credentials' }, 401);
    }
    if (user.password_hash === '') {
        // Accepted enumeration trade-off: Google-only account.
        return c.json({ error: 'use_google' }, 401);
    }

    const valid = await verifyPassword(password, user.password_hash, user.salt);
    if (!valid) {
        return c.json({ error: 'Invalid credentials' }, 401);
    }

    logAuthEvent('login', { userId: user.id });
    return c.json(await mintAuthResponse(user, c.env.JWT_SECRET));
});

authRouter.get('/v1/auth/me', authMiddleware(), async (c) => {
    const authUser = c.get('user') as AuthPayload;
    const db = c.env.arcane_db;

    const user = await findUserById(db, parseInt(authUser.sub));
    if (!user) {
        return c.json({ error: 'User not found' }, 404);
    }

    const periodStart = getCurrentPeriodStart();
    const usage = await findCurrentUsagePeriod(db, user.id, periodStart);

    return c.json({
        user: makeUserResponse(user),
        hasPassword: user.password_hash !== '',
        googleLinked: user.google_sub !== null,
        usage: {
            totalRequests: usage?.total_requests ?? 0,
            totalInputTokens: usage?.total_input_tokens ?? 0,
            totalOutputTokens: usage?.total_output_tokens ?? 0,
        },
    });
});

// ─── Device Auth Flow ───────────────────────────────────────

// Step 1: IDE requests a device code
authRouter.post('/v1/auth/device/code', async (c) => {
    const db = c.env.arcane_db;

    // Clean up expired codes opportunistically
    await cleanExpiredDeviceCodes(db);

    const deviceCode = crypto.randomUUID();
    const userCode = generateUserCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    await createDeviceCode(db, { deviceCode, userCode, expiresAt });

    return c.json({
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: `${c.env.WEB_BASE_URL}/auth/device`,
        expires_in: 900,
        interval: 5,
    });
});

// Step 2: Logged-in user on web authorizes the device code
authRouter.post('/v1/auth/device/authorize', authMiddleware(), async (c) => {
    const { user_code } = await c.req.json<{ user_code?: string }>();
    if (!user_code) {
        return c.json({ error: 'user_code is required' }, 400);
    }

    const authUser = c.get('user') as AuthPayload;
    const db = c.env.arcane_db;

    const authorized = await authorizeDeviceCode(db, user_code, parseInt(authUser.sub));
    if (!authorized) {
        return c.json({ error: 'Invalid or expired device code' }, 400);
    }

    return c.json({ success: true });
});

// Step 3: IDE polls for the token
authRouter.post('/v1/auth/device/token', async (c) => {
    const { device_code } = await c.req.json<{ device_code?: string }>();
    if (!device_code) {
        return c.json({ error: 'device_code is required' }, 400);
    }

    const db = c.env.arcane_db;
    const record = await findDeviceCodeByDeviceCode(db, device_code);

    if (!record) {
        return c.json({ error: 'invalid_device_code' }, 400);
    }

    if (new Date(record.expires_at) < new Date()) {
        await deleteDeviceCode(db, record.id);
        return c.json({ error: 'expired_token' }, 400);
    }

    if (record.status === 'pending') {
        return c.json({ error: 'authorization_pending' }, 428);
    }

    if (record.status === 'authorized' && record.user_id) {
        const user = await findUserById(db, record.user_id);
        if (!user) { return c.json({ error: 'user_not_found' }, 404); }

        // Clean up used device code
        await deleteDeviceCode(db, record.id);

        logAuthEvent('device_login', { userId: user.id });
        return c.json(await mintAuthResponse(user, c.env.JWT_SECRET));
    }

    return c.json({ error: 'unknown_status' }, 500);
});
