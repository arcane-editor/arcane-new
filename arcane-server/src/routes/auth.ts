import { Hono } from 'hono';
import {
    findUserByEmail, findUserById, createUser,
    findCurrentUsagePeriod, getCurrentPeriodStart,
    createDeviceCode, findDeviceCodeByDeviceCode,
    authorizeDeviceCode, deleteDeviceCode, cleanExpiredDeviceCodes,
} from '../lib/db.ts';
import { hashPassword, verifyPassword } from '../lib/crypto.ts';
import { signJwt, authMiddleware } from '../middleware/auth.ts';
import type { AuthPayload } from '../middleware/auth.ts';
import type { AppEnv } from '../types.ts';

export const authRouter = new Hono<AppEnv>();

// ─── Helpers ────────────────────────────────────────────────

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

function makeJwtPayload(user: { id: number; email: string; role: string }): AuthPayload {
    return { sub: String(user.id), email: user.email, role: user.role };
}

function makeUserResponse(user: { id: number; email: string; role: string }) {
    return {
        id: user.id,
        email: user.email,
        role: user.role,
    };
}

// ─── Signup / Login ─────────────────────────────────────────

authRouter.post('/v1/auth/signup', async (c) => {
    const { email, password } = await c.req.json();

    if (!email || !password) {
        return c.json({ error: 'Email and password required' }, 400);
    }

    const db = c.env.arcane_db;

    const existing = await findUserByEmail(db, email);
    if (existing) {
        return c.json({ error: 'Email already registered' }, 409);
    }

    const { hash, salt } = await hashPassword(password);
    const user = await createUser(db, { email, passwordHash: hash, salt });

    const token = await signJwt(makeJwtPayload(user), c.env.JWT_SECRET);

    return c.json({
        token,
        user: makeUserResponse(user),
    });
});

authRouter.post('/v1/auth/login', async (c) => {
    const { email, password } = await c.req.json();

    if (!email || !password) {
        return c.json({ error: 'Email and password required' }, 400);
    }

    const db = c.env.arcane_db;

    const user = await findUserByEmail(db, email);
    if (!user) {
        return c.json({ error: 'Invalid credentials' }, 401);
    }

    const valid = await verifyPassword(password, user.password_hash, user.salt);
    if (!valid) {
        return c.json({ error: 'Invalid credentials' }, 401);
    }

    const token = await signJwt(makeJwtPayload(user), c.env.JWT_SECRET);

    return c.json({
        token,
        user: makeUserResponse(user),
    });
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
        verification_uri: 'https://arcaneai.org/auth/device',
        expires_in: 900,
        interval: 5,
    });
});

// Step 2: Logged-in user on web authorizes the device code
authRouter.post('/v1/auth/device/authorize', authMiddleware(), async (c) => {
    const { user_code } = await c.req.json();
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
    const { device_code } = await c.req.json();
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

        const token = await signJwt(makeJwtPayload(user), c.env.JWT_SECRET);

        // Clean up used device code
        await deleteDeviceCode(db, record.id);

        return c.json({
            token,
            user: makeUserResponse(user),
        });
    }

    return c.json({ error: 'unknown_status' }, 500);
});
