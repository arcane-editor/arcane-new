import { Hono } from 'hono';
import { jwtVerify } from 'jose';
import { createClientError } from '../lib/db.ts';
import { JWT_ISSUER } from '../middleware/auth.ts';
import type { AuthPayload } from '../middleware/auth.ts';
import type { AppEnv } from '../types.ts';

/**
 * `POST /v1/client-error` — crash reports from the desktop editor.
 *
 * PUBLIC by design. The React error boundary that feeds this sits above the
 * AI panel's `!loggedIn` branch, so the crash we most want to see is the one
 * that happens before there is any token to send. Requiring auth would filter
 * out exactly that case.
 *
 * Two sinks, deliberately:
 *  - `console.error` → Workers Logs (`[observability]`, already enabled) is the
 *    live tail you watch with `wrangler tail` while reproducing.
 *  - `client_errors` (D1) is the durable copy, because logs age out in days and
 *    a desktop crash gets looked at long after it was reported.
 *
 * The validation rule is "never lose a real crash over a schema nit": only
 * `message` is required, everything else is coerced and capped. An oversized
 * stack is TRUNCATED, not rejected — a 40KB stack is still the best evidence
 * we will get, and dropping it would leave nothing at all.
 */

export const clientErrorRouter = new Hono<AppEnv>();

/** Field caps. Generous enough for a real React stack, small enough that a
 *  crash loop cannot write unbounded rows. */
const LIMITS = {
    kind: 64,
    message: 2_048,
    stack: 8_192,
    componentStack: 8_192,
    appVersion: 32,
    channel: 16,
    os: 32,
    sessionId: 64,
} as const;

/** Cap a string and SAY it was capped. A silently clipped stack reads as a
 *  complete one and sends the next reader hunting for a frame we dropped. */
function cap(value: unknown, max: number): string {
    if (typeof value !== 'string') return '';
    if (value.length <= max) return value;
    return `${value.slice(0, max)}… [truncated ${value.length - max} chars]`;
}

/**
 * Best-effort identity. A failure here must never fail the report: an expired
 * or malformed token is not a reason to drop a crash, so every path falls back
 * to an anonymous row.
 */
async function userIdFrom(authHeader: string | undefined, secret: string): Promise<string | null> {
    if (!authHeader?.startsWith('Bearer ')) return null;
    try {
        const { payload } = await jwtVerify(
            authHeader.slice(7),
            new TextEncoder().encode(secret),
            { issuer: JWT_ISSUER, algorithms: ['HS256'] },
        );
        const sub = (payload as unknown as AuthPayload).sub;
        return typeof sub === 'string' && sub.length > 0 ? sub : null;
    } catch {
        return null;
    }
}

clientErrorRouter.post('/v1/client-error', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return c.json({ error: 'Body must be a JSON object' }, 400);
    }

    const b = body as Record<string, unknown>;
    const message = cap(b.message, LIMITS.message).trim();
    if (!message) {
        return c.json({ error: 'message is required' }, 400);
    }

    const userId = await userIdFrom(c.req.header('Authorization'), c.env.JWT_SECRET);
    const report = {
        kind: cap(b.kind, LIMITS.kind) || 'unknown',
        message,
        stack: cap(b.stack, LIMITS.stack),
        componentStack: cap(b.componentStack, LIMITS.componentStack),
        appVersion: cap(b.appVersion, LIMITS.appVersion),
        channel: cap(b.channel, LIMITS.channel),
        os: cap(b.os, LIMITS.os),
        sessionId: cap(b.sessionId, LIMITS.sessionId),
        userId,
    };

    // One structured line so Workers Logs can be filtered on `event`.
    console.error(JSON.stringify({ event: 'client_error', ...report }));

    await createClientError(c.env.arcane_db, report);

    return c.json({ ok: true }, 202);
});
