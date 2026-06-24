import type { MiddlewareHandler } from 'hono';
import { jwtVerify, SignJWT } from 'jose';
import type { AppEnv } from '../types.ts';

const JWT_ISSUER = 'arcane-server';
const JWT_EXPIRY = '30d';

export interface AuthPayload {
    sub: string;
    email: string;
    role: string;
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
            const result = await jwtVerify(token, secret, {
                issuer: JWT_ISSUER,
            });
            payload = result.payload as unknown as AuthPayload;
        } catch {
            return c.json({ error: 'Invalid or expired token' }, 401);
        }

        c.set('user', payload);
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
