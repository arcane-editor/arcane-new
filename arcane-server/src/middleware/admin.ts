import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types.ts';
import type { AuthPayload } from './auth.ts';

export function adminMiddleware(): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
        const user = c.get('user') as AuthPayload;
        if (!user.role || user.role !== 'admin') {
            return c.json({ error: 'Admin access required' }, 403);
        }
        await next();
    };
}
