import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types.ts';

const warned = new Set<string>();

/** Cloudflare ratelimit-binding middleware, keyed on the caller's IP.
 *  Fails open (with a once-per-isolate warning) when the binding is absent —
 *  local dev and the vitest pool run without unsafe bindings. */
export function rateLimit(bindingName: 'RL_AUTH_STRICT' | 'RL_AUTH_POLL' | 'RL_CLIENT_ERROR'): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
        const limiter = c.env[bindingName];
        if (!limiter) {
            if (!warned.has(bindingName)) {
                warned.add(bindingName);
                console.warn(JSON.stringify({ event: 'auth_rate_limit_skipped', binding: bindingName }));
            }
            await next();
            return;
        }
        const key = c.req.header('CF-Connecting-IP') ?? 'unknown';
        const { success } = await limiter.limit({ key });
        if (!success) {
            return c.json({ error: 'rate_limited' }, 429);
        }
        await next();
    };
}
