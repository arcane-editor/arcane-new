import { Hono } from 'hono';
import type { AppEnv } from '../types.ts';
import { adminAccess } from '../middleware/admin.ts';
import { signAdminJwt } from '../middleware/auth.ts';
import {
    findAllUsersWithUsage, createUser, deleteUser, findUserById,
    updatePasswordBumpVersion,
    getCurrentPeriodStart,
    findAllFeedback,
} from '../lib/db.ts';
import { hashPassword, digestsMatch } from '../lib/crypto.ts';

export const adminRouter = new Hono<AppEnv>();

// Owner's email — the only identity POST /v1/admin/login accepts alongside
// ADMIN_PASSWORD. Deliberate code constant (owner directive), not env-driven.
export const OWNER_EMAIL = 'sourav.das120699@gmail.com';

// Registered ABOVE the adminAccess() `.use` below — Hono composes
// middleware/routes in registration order, and this handler returns a
// Response without calling next(), so a request that matches this exact
// route never reaches adminAccess(). That's necessary: this is how an
// env-admin token is minted in the first place.
adminRouter.post('/v1/admin/login', async (c) => {
    if (!c.env.ADMIN_PASSWORD) {
        return c.json({ error: 'Admin login is not configured', code: 'admin_unconfigured' }, 503);
    }

    const { email, password } = await c.req.json<Record<string, unknown>>();
    if (typeof email !== 'string' || typeof password !== 'string') {
        return c.json({ error: 'email and password are required' }, 400);
    }

    // The password check is a constant-time digest compare (lib/crypto.ts)
    // and MUST run unconditionally — never short-circuited by the email
    // check — so response timing never reveals which half (email vs
    // password) was wrong. Both failure modes return the identical 401 body.
    const emailOk = email === OWNER_EMAIL;
    const passwordOk = await digestsMatch(password, c.env.ADMIN_PASSWORD);
    if (!emailOk || !passwordOk) {
        return c.json({ error: 'Invalid credentials' }, 401);
    }

    const token = await signAdminJwt(OWNER_EMAIL, c.env.JWT_SECRET);
    return c.json({ token });
});

// All other admin routes require adminAccess() (env-admin token OR a DB
// user row with role = 'admin').
adminRouter.use('/v1/admin/*', adminAccess());

// ─── API: Users ──────────────────────────────────────────────

adminRouter.get('/v1/admin/users', async (c) => {
    const periodStart = getCurrentPeriodStart();
    const users = await findAllUsersWithUsage(c.env.arcane_db, periodStart);

    return c.json(users.map(u => ({
        id: u.id,
        email: u.email,
        role: u.role,
        createdAt: u.created_at,
        usage: {
            totalRequests: u.total_requests ?? 0,
        },
    })));
});

adminRouter.post('/v1/admin/users', async (c) => {
    const { email, password } = await c.req.json();
    if (!email || !password) {
        return c.json({ error: 'email and password are required' }, 400);
    }
    const { hash, salt } = await hashPassword(password);
    const user = await createUser(c.env.arcane_db, {
        email, passwordHash: hash, salt, emailVerified: true,
    });
    return c.json({ id: user.id, email: user.email, role: user.role }, 201);
});

adminRouter.put('/v1/admin/users/:id', async (c) => {
    const { id } = c.req.param();
    const updates = await c.req.json<{ password?: string }>();
    if (!updates.password) {
        const user = await findUserById(c.env.arcane_db, parseInt(id));
        if (!user) return c.json({ error: 'User not found' }, 404);
        return c.json({ id: user.id, email: user.email, role: user.role });
    }
    const { hash, salt } = await hashPassword(updates.password);
    // token_version bump — an admin password set revokes the user's sessions.
    const user = await updatePasswordBumpVersion(c.env.arcane_db, parseInt(id), hash, salt);
    if (!user) return c.json({ error: 'User not found' }, 404);
    return c.json({ id: user.id, email: user.email, role: user.role });
});

adminRouter.delete('/v1/admin/users/:id', async (c) => {
    const { id } = c.req.param();
    const deleted = await deleteUser(c.env.arcane_db, parseInt(id));
    if (!deleted) return c.json({ error: 'User not found' }, 404);
    return c.json({ ok: true });
});

// ─── API: Feedback (admin view) ──────────────────────────────

adminRouter.get('/v1/admin/feedback', async (c) => {
    const feedback = await findAllFeedback(c.env.arcane_db);
    return c.json({ feedback });
});
