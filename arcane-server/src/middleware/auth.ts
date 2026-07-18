import type { MiddlewareHandler } from 'hono';
import { jwtVerify, SignJWT } from 'jose';
import type { AppEnv } from '../types.ts';
import type { UserRow } from '../lib/db.ts';

const JWT_ISSUER = 'arcane-server';
const JWT_EXPIRY = '30d';

export interface AuthPayload {
    sub: string;
    email: string;
    role: string;
    /** Missing on legacy (pre-0012) tokens — middleware refreshes from DB. */
    email_verified?: boolean;
    /** Missing on legacy tokens — treated as version 0. */
    token_version?: number;
}

/** Single source of truth for JWT claims — EVERY mint point MUST use this
 *  so tokens are indistinguishable regardless of which flow issued them. */
export function makeJwtPayloadFromUser(user: UserRow): AuthPayload {
    return {
        sub: String(user.id),
        email: user.email,
        role: user.role,
        email_verified: user.email_verified === 1,
        token_version: user.token_version,
    };
}

/** Public user shape returned by every auth endpoint. */
export function makeUserResponse(user: UserRow) {
    return {
        id: user.id,
        email: user.email,
        role: user.role,
        emailVerified: user.email_verified === 1,
    };
}

/** {token, user} — the standard success body for every login-ish route. */
export async function mintAuthResponse(user: UserRow, jwtSecret: string) {
    const token = await signJwt(makeJwtPayloadFromUser(user), jwtSecret);
    return { token, user: makeUserResponse(user) };
}

export function authMiddleware(): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
        const authHeader = c.req.header('Authorization');
        if (!authHeader?.startsWith('Bearer ')) {
            return c.json({ error: 'Missing or invalid Authorization header' }, 401);
        }

        const token = authHeader.slice(7);
        const secret = new TextEncoder().encode(c.env.JWT_SECRET);
        let payload: AuthPayload;
        try {
            const result = await jwtVerify(token, secret, { issuer: JWT_ISSUER });
            payload = result.payload as unknown as AuthPayload;
        } catch {
            return c.json({ error: 'Invalid or expired token' }, 401);
        }

        // One PK-indexed read per request: catches deleted users, revoked
        // sessions (token_version bump), and refreshes role/email_verified so
        // a 30-day JWT never serves stale authorization data. Legacy tokens
        // (no token_version claim) are version 0 — matching the 0012 default,
        // which keeps existing testers' tokens working.
        const row = await c.env.arcane_db.prepare(
            'SELECT id, role, email_verified, token_version FROM users WHERE id = ?'
        ).bind(parseInt(payload.sub)).first<{
            id: number; role: string; email_verified: number; token_version: number;
        }>();
        if (!row || (payload.token_version ?? 0) !== row.token_version) {
            return c.json({ error: 'Invalid or expired token' }, 401);
        }

        c.set('user', {
            ...payload,
            role: row.role,
            email_verified: row.email_verified === 1,
            token_version: row.token_version,
        });
        await next();
    };
}

/** 403 gate for AI routes. MUST run AFTER authMiddleware() — it reads the
 *  DB-fresh email_verified that authMiddleware placed on the context. */
export function requireVerifiedEmail(): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
        const user = c.get('user') as AuthPayload;
        if (!user.email_verified) {
            return c.json({ error: 'email_unverified' }, 403);
        }
        await next();
    };
}

export async function signJwt(payload: AuthPayload, jwtSecret: string): Promise<string> {
    const secret = new TextEncoder().encode(jwtSecret);
    return new SignJWT(payload as unknown as Record<string, unknown>)
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setIssuer(JWT_ISSUER)
        .setExpirationTime(JWT_EXPIRY)
        .sign(secret);
}
