import type { MiddlewareHandler } from 'hono';
import { jwtVerify } from 'jose';
import type { AppEnv } from '../types.ts';
import { JWT_ISSUER, loadFreshUser } from './auth.ts';
import type { AuthPayload } from './auth.ts';

/**
 * Unified gate for every `/v1/admin/*` route (except POST /v1/admin/login,
 * which is registered ahead of this middleware in routes/admin.ts so it can
 * mint the very token this gate checks). Accepts either:
 *
 *   1. An env-admin token — `adm: true` claim, minted by POST
 *      /v1/admin/login from the ADMIN_PASSWORD secret. No DB row backs this
 *      identity, so it's trusted directly off the verified JWT claims.
 *   2. An ordinary user JWT whose DB row currently has role = 'admin'.
 *
 * Env-admin tokens are deliberately rejected by ordinary authMiddleware()
 * routes: their `sub` ('env-admin') is not a numeric user id, so
 * authMiddleware's per-request DB lookup finds no matching row and it 401s.
 * That's privilege separation working as intended (the env-admin credential
 * is scoped to /v1/admin/* only) — not a bug.
 */
export function adminAccess(): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
        const authHeader = c.req.header('Authorization');
        if (!authHeader?.startsWith('Bearer ')) {
            return c.json({ error: 'Unauthorized' }, 401);
        }

        const token = authHeader.slice(7);
        const secret = new TextEncoder().encode(c.env.JWT_SECRET);
        let payload: AuthPayload;
        try {
            const result = await jwtVerify(token, secret, { issuer: JWT_ISSUER, algorithms: ['HS256'] });
            payload = result.payload as unknown as AuthPayload;
        } catch {
            return c.json({ error: 'Unauthorized' }, 401);
        }

        if (payload.adm === true) {
            c.set('user', payload);
            await next();
            return;
        }

        const fresh = await loadFreshUser(c.env.arcane_db, payload);
        if (!fresh) {
            return c.json({ error: 'Unauthorized' }, 401);
        }
        if (fresh.role !== 'admin') {
            return c.json({ error: 'Admin access required' }, 403);
        }

        c.set('user', fresh);
        await next();
    };
}
