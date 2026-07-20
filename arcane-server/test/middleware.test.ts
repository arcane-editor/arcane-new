import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import {
    authMiddleware, requireVerifiedEmail, makeJwtPayloadFromUser, makeUserResponse,
} from '../src/middleware/auth.ts';
import { rateLimit } from '../src/middleware/rate-limit.ts';
import app from '../index.ts';
import { bumpTokenVersion, deleteUser } from '../src/lib/db.ts';
import type { AppEnv } from '../src/types.ts';
import type { AuthPayload } from '../src/middleware/auth.ts';
import { seedPasswordUser, tokenFor } from './helpers.ts';

// Tiny app exercising authMiddleware in isolation, with env injected via
// Hono's app.request(path, init, env) third argument.
function protectedApp() {
    const app = new Hono<AppEnv>();
    app.use('*', authMiddleware());
    app.get('/whoami', (c) => c.json(c.get('user')));
    return app;
}
const bindings = () => ({ arcane_db: env.arcane_db, JWT_SECRET: env.JWT_SECRET });

// Pre-0012 token: no email_verified / token_version claims.
async function legacyToken(user: { id: number; email: string; role: string }): Promise<string> {
    const secret = new TextEncoder().encode(env.JWT_SECRET);
    return new SignJWT({ sub: String(user.id), email: user.email, role: user.role })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setIssuer('arcane-server')
        .setExpirationTime('30d')
        .sign(secret);
}

describe('authMiddleware', () => {
    it('accepts a current token and refreshes email_verified/role from D1', async () => {
        const user = await seedPasswordUser('mw1@test.dev', 'password123', { verified: false });
        const res = await protectedApp().request('/whoami',
            { headers: { Authorization: `Bearer ${await tokenFor(user)}` } }, bindings());
        expect(res.status).toBe(200);
        const payload = await res.json<AuthPayload>();
        expect(payload.email_verified).toBe(false);
        expect(payload.token_version).toBe(0);
    });

    it('grandfathers legacy tokens without new claims as version 0', async () => {
        const user = await seedPasswordUser('legacy@test.dev', 'password123');
        const res = await protectedApp().request('/whoami',
            { headers: { Authorization: `Bearer ${await legacyToken(user)}` } }, bindings());
        expect(res.status).toBe(200);
        const payload = await res.json<AuthPayload>();
        expect(payload.email_verified).toBe(true);   // refreshed from DB
        expect(payload.token_version).toBe(0);
    });

    it('rejects tokens after token_version is bumped (session revocation)', async () => {
        const user = await seedPasswordUser('bumped@test.dev', 'password123');
        const stale = await tokenFor(user);
        await bumpTokenVersion(env.arcane_db, user.id);
        const res = await protectedApp().request('/whoami',
            { headers: { Authorization: `Bearer ${stale}` } }, bindings());
        expect(res.status).toBe(401);
    });

    it('rejects tokens whose user was deleted', async () => {
        const user = await seedPasswordUser('gone@test.dev', 'password123');
        const token = await tokenFor(user);
        await deleteUser(env.arcane_db, user.id);
        const res = await protectedApp().request('/whoami',
            { headers: { Authorization: `Bearer ${token}` } }, bindings());
        expect(res.status).toBe(401);
    });
});

describe('requireVerifiedEmail', () => {
    function gatedApp(emailVerified: boolean) {
        const app = new Hono<AppEnv>();
        app.use('*', async (c, next) => {
            c.set('user', { sub: '1', email: 'x@y.z', role: 'user', email_verified: emailVerified, token_version: 0 });
            await next();
        });
        app.use('*', requireVerifiedEmail());
        app.get('/ai', (c) => c.json({ ok: true }));
        return app;
    }

    it('403 email_unverified when unverified', async () => {
        const res = await gatedApp(false).request('/ai');
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'email_unverified' });
    });

    it('passes when verified', async () => {
        const res = await gatedApp(true).request('/ai');
        expect(res.status).toBe(200);
    });
});

describe('rateLimit middleware', () => {
    function rlApp() {
        const app = new Hono<AppEnv>();
        app.use('*', rateLimit('RL_AUTH_STRICT'));
        app.get('/x', (c) => c.json({ ok: true }));
        return app;
    }

    it('429 rate_limited when the binding denies', async () => {
        const res = await rlApp().request('/x',
            { headers: { 'CF-Connecting-IP': '1.2.3.4' } },
            { RL_AUTH_STRICT: { limit: async () => ({ success: false }) } });
        expect(res.status).toBe(429);
        expect(await res.json()).toEqual({ error: 'rate_limited' });
    });

    it('keys on CF-Connecting-IP and passes when allowed', async () => {
        const keys: string[] = [];
        const res = await rlApp().request('/x',
            { headers: { 'CF-Connecting-IP': '5.6.7.8' } },
            { RL_AUTH_STRICT: { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: true }; } } });
        expect(res.status).toBe(200);
        expect(keys).toEqual(['5.6.7.8']);
    });

    it('fails open when the binding is missing (local dev/tests)', async () => {
        const res = await rlApp().request('/x', {}, {});
        expect(res.status).toBe(200);
    });
});

// Wiring tests: unlike the isolated-app tests above, these hit the REAL
// index.ts app (imported directly) to confirm specific paths are actually
// registered behind a limiter — the app.use(path, limiter) placement, not
// just the middleware function in isolation. Same fake-limiter-injection
// pattern via Hono's app.request(path, init, env) third argument.
describe('index.ts rate-limit wiring', () => {
    it('GET /v1/auth/google/start is behind RL_AUTH_STRICT', async () => {
        const res = await app.request('/v1/auth/google/start',
            { headers: { 'CF-Connecting-IP': '1.2.3.4' } },
            { RL_AUTH_STRICT: { limit: async () => ({ success: false }) } });
        expect(res.status).toBe(429);
        expect(await res.json()).toEqual({ error: 'rate_limited' });
    });

    it('POST /v1/auth/device/code is behind RL_AUTH_POLL', async () => {
        const res = await app.request('/v1/auth/device/code',
            {
                method: 'POST',
                headers: { 'CF-Connecting-IP': '1.2.3.4', 'Content-Type': 'application/json' },
                body: '{}',
            },
            { RL_AUTH_POLL: { limit: async () => ({ success: false }) } });
        expect(res.status).toBe(429);
        expect(await res.json()).toEqual({ error: 'rate_limited' });
    });
});

describe('claim/response builders', () => {
    it('makeJwtPayloadFromUser and makeUserResponse emit the exact shapes', async () => {
        const user = await seedPasswordUser('shape@test.dev', 'password123');
        expect(makeJwtPayloadFromUser(user)).toEqual({
            sub: String(user.id), email: 'shape@test.dev', role: 'user',
            email_verified: true, token_version: 0,
        });
        // Freshly-seeded user: free tier, 0 credits until the first AI call
        // anchors the cycle (migration grandfather only touched pre-existing rows).
        expect(makeUserResponse(user)).toEqual({
            id: user.id, email: 'shape@test.dev', role: 'user', emailVerified: true,
            plan: 'free', credits: 0,
        });
    });
});
