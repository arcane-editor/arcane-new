import { Hono } from 'hono';
import {
    findUserByEmail, findUserById, createUser,
    findCurrentUsagePeriod, getCurrentPeriodStart,
    createAuthToken,
} from '../lib/db.ts';
import { hashPassword, verifyPassword } from '../lib/crypto.ts';
import { authMiddleware, mintAuthResponse, makeUserResponse } from '../middleware/auth.ts';
import type { AuthPayload } from '../middleware/auth.ts';
import { generateOtp, otpHash, TOKEN_TTL_SECONDS } from '../lib/tokens.ts';
import { sendVerificationEmail } from '../lib/email.ts';
import { verifyTurnstile } from '../lib/turnstile.ts';
import { logAuthEvent } from '../lib/log.ts';
import type { AppEnv } from '../types.ts';

export const authRouter = new Hono<AppEnv>();

// ─── Helpers ────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

    const code = generateOtp();
    await createAuthToken(db, {
        userId: user.id, purpose: 'verify_email',
        tokenHash: await otpHash(user.id, code), ttlSeconds: TOKEN_TTL_SECONDS.verify_email,
    });
    c.executionCtx.waitUntil(sendVerificationEmail(c.env, user.email, code));
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
        githubLinked: user.github_id !== null,
        usage: {
            totalRequests: usage?.total_requests ?? 0,
            totalInputTokens: usage?.total_input_tokens ?? 0,
            totalOutputTokens: usage?.total_output_tokens ?? 0,
        },
    });
});
