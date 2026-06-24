import { Hono } from 'hono';
import type { AppEnv } from '../types.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { adminMiddleware } from '../middleware/admin.ts';
import {
    findAllUsersWithUsage, createUser, updateUser, deleteUser,
    getCurrentPeriodStart,
    findAllFeedback,
} from '../lib/db.ts';
import { hashPassword } from '../lib/crypto.ts';

export const adminRouter = new Hono<AppEnv>();

// All admin routes require auth + admin role
adminRouter.use('/v1/admin/*', authMiddleware(), adminMiddleware());

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
    const user = await createUser(c.env.arcane_db, { email, passwordHash: hash, salt });
    return c.json({ id: user.id, email: user.email, role: user.role }, 201);
});

adminRouter.put('/v1/admin/users/:id', async (c) => {
    const { id } = c.req.param();
    const updates = await c.req.json();
    const allowed: { passwordHash?: string; salt?: string } = {};
    if (updates.password) {
        const { hash, salt } = await hashPassword(updates.password);
        allowed.passwordHash = hash;
        allowed.salt = salt;
    }
    const user = await updateUser(c.env.arcane_db, parseInt(id), allowed);
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
