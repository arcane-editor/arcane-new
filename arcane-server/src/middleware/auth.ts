import type { MiddlewareHandler } from 'hono';
import { jwtVerify, SignJWT } from 'jose';
import type { AppEnv } from '../types.ts';
import type { UserRow } from '../lib/db.ts';
import { microToCredits } from '../config/tiers.ts';

// Exported so middleware/admin.ts's adminAccess() can verify with the exact
// same jose config (issuer + algorithm) without duplicating the literal.
export const JWT_ISSUER = 'arcane-server';
const JWT_EXPIRY = '30d';
const ADMIN_JWT_EXPIRY = '12h';

export interface AuthPayload {
    sub: string;
    email: string;
    role: string;
    /** Missing on legacy (pre-0012) tokens — middleware refreshes from DB. */
    email_verified?: boolean;
    /** Missing on legacy tokens — treated as version 0. */
    token_version?: number;
    /** Present + true only on an env-admin token minted by POST
     *  /v1/admin/login from the ADMIN_PASSWORD secret. No DB row backs this
     *  identity — see adminAccess() in middleware/admin.ts. */
    adm?: boolean;
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

/** Public user shape returned by every auth endpoint. `credits` is the whole
 *  spendable balance (plan + top-up) in user-facing credits; the editor and
 *  website read `plan`/`credits` to render the account + AI-gate state. A
 *  freshly-created user shows 0 until their first AI call anchors the free
 *  cycle (the /v1/usage route refreshes it explicitly). */
export function makeUserResponse(user: UserRow) {
    return {
        id: user.id,
        email: user.email,
        role: user.role,
        emailVerified: user.email_verified === 1,
        plan: user.plan,
        credits: microToCredits(user.plan_credits_micro + user.topup_credits_micro),
    };
}

/** {token, user} — the standard success body for every login-ish route. */
export async function mintAuthResponse(user: UserRow, jwtSecret: string) {
    const token = await signJwt(makeJwtPayloadFromUser(user), jwtSecret);
    return { token, user: makeUserResponse(user) };
}

/**
 * One PK-indexed read per request: catches deleted users, revoked sessions
 * (token_version bump), and refreshes role/email_verified so a 30-day JWT
 * never serves stale authorization data. Legacy tokens (no token_version
 * claim) are version 0 — matching the 0012 default, which keeps existing
 * testers' tokens working. Returns null on a missing user or a token_version
 * mismatch (both mean "reject this token").
 */
export async function loadFreshUser(db: D1Database, payload: AuthPayload): Promise<AuthPayload | null> {
    const row = await db.prepare(
        'SELECT id, role, email_verified, token_version FROM users WHERE id = ?'
    ).bind(parseInt(payload.sub)).first<{
        id: number; role: string; email_verified: number; token_version: number;
    }>();
    if (!row || (payload.token_version ?? 0) !== row.token_version) {
        return null;
    }
    return {
        ...payload,
        role: row.role,
        email_verified: row.email_verified === 1,
        token_version: row.token_version,
    };
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
            const result = await jwtVerify(token, secret, { issuer: JWT_ISSUER, algorithms: ['HS256'] });
            payload = result.payload as unknown as AuthPayload;
        } catch {
            return c.json({ error: 'Invalid or expired token' }, 401);
        }

        const fresh = await loadFreshUser(c.env.arcane_db, payload);
        if (!fresh) {
            return c.json({ error: 'Invalid or expired token' }, 401);
        }

        c.set('user', fresh);
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

/** Mint an env-admin token (POST /v1/admin/login success path) — same jose
 *  signing path as signJwt, but a short 12h expiry and the `adm: true` claim
 *  that marks it as backed by ADMIN_PASSWORD rather than a DB user row. */
export async function signAdminJwt(email: string, jwtSecret: string): Promise<string> {
    const secret = new TextEncoder().encode(jwtSecret);
    const payload: AuthPayload = { sub: 'env-admin', email, role: 'admin', adm: true };
    return new SignJWT(payload as unknown as Record<string, unknown>)
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setIssuer(JWT_ISSUER)
        .setExpirationTime(ADMIN_JWT_EXPIRY)
        .sign(secret);
}
