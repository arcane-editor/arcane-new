import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { jwtVerify, SignJWT, createRemoteJWKSet } from 'jose';
import {
    findUserByGoogleSub, findUserByEmail, linkGoogleSub, linkGoogleSubClearingCredentials, createOAuthUser,
    findUserById, createAuthToken, consumeAuthToken, cleanExpiredAuthTokens,
} from '../lib/db.ts';
import type { UserRow } from '../lib/db.ts';
import { generateToken, sha256Hex, s256Challenge, TOKEN_TTL_SECONDS } from '../lib/tokens.ts';
import { mintAuthResponse } from '../middleware/auth.ts';
import { logAuthEvent } from '../lib/log.ts';
import type { AppEnv } from '../types.ts';

export const authGoogleRouter = new Hono<AppEnv>();

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Lazy: createRemoteJWKSet only fetches on first verify, so module scope is safe.
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const OAUTH_COOKIE = 'g_oauth';
const OAUTH_COOKIE_ISSUER = 'arcane-server-google-oauth';
const RETURN_TO_ALLOWLIST = ['/auth', '/auth/device', '/account'];

interface OAuthCookiePayload {
    state: string;
    nonce: string;
    pkce_verifier: string;
    return_to: string;
}

// The state cookie is a 10-minute HS256 JWT under the existing JWT_SECRET —
// same jose primitives as session tokens, distinct issuer so neither can be
// replayed as the other.
async function signOAuthCookie(payload: OAuthCookiePayload, jwtSecret: string): Promise<string> {
    const secret = new TextEncoder().encode(jwtSecret);
    return new SignJWT(payload as unknown as Record<string, unknown>)
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setIssuer(OAUTH_COOKIE_ISSUER)
        .setExpirationTime('10m')
        .sign(secret);
}

async function verifyOAuthCookie(token: string, jwtSecret: string): Promise<OAuthCookiePayload | null> {
    try {
        const secret = new TextEncoder().encode(jwtSecret);
        const { payload } = await jwtVerify(token, secret, { issuer: OAUTH_COOKIE_ISSUER });
        return payload as unknown as OAuthCookiePayload;
    } catch {
        return null;
    }
}

/** Account decision: login by google_sub → link by email → create.
 *  Returns null on a link conflict (email already bound to a DIFFERENT
 *  Google subject). Exported for unit tests. */
export async function resolveGoogleAccount(
    db: D1Database, googleSub: string, email: string,
): Promise<UserRow | null> {
    const bySub = await findUserByGoogleSub(db, googleSub);
    if (bySub) { return bySub; }
    const byEmail = await findUserByEmail(db, email);
    if (byEmail) {
        if (byEmail.google_sub && byEmail.google_sub !== googleSub) {
            return null;
        }
        // An unverified row's password can't be trusted (anyone could have
        // pre-registered the victim's email before they arrived via Google),
        // so linking onto it clears the credential and revokes any sessions
        // that password minted. Verified rows keep their password as-is.
        return byEmail.email_verified === 1
            ? linkGoogleSub(db, byEmail.id, googleSub)
            : linkGoogleSubClearingCredentials(db, byEmail.id, googleSub);
    }
    return createOAuthUser(db, { email, googleSub });
}

// ─── Start: 302 to Google with PKCE + nonce, state in a signed cookie ──

authGoogleRouter.get('/v1/auth/google/start', async (c) => {
    if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
        return c.redirect(`${c.env.WEB_BASE_URL}/auth?error=google_not_configured`, 302);
    }
    const requested = c.req.query('return_to') ?? '/auth';
    const returnTo = RETURN_TO_ALLOWLIST.includes(requested) ? requested : '/auth';

    const state = generateToken();
    const nonce = generateToken();
    const pkceVerifier = generateToken();
    const challenge = await s256Challenge(pkceVerifier);

    const cookie = await signOAuthCookie(
        { state, nonce, pkce_verifier: pkceVerifier, return_to: returnTo }, c.env.JWT_SECRET);
    setCookie(c, OAUTH_COOKIE, cookie, {
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        path: '/v1/auth/google',
        maxAge: 600,
    });

    const params = new URLSearchParams({
        client_id: c.env.GOOGLE_CLIENT_ID,
        redirect_uri: `${c.env.API_BASE_URL}/v1/auth/google/callback`,
        response_type: 'code',
        scope: 'openid email',
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
    });
    return c.redirect(`${GOOGLE_AUTH_URL}?${params}`, 302);
});

// ─── Callback: verify state/nonce/ID token → 60s web_login code ──

authGoogleRouter.get('/v1/auth/google/callback', async (c) => {
    const fail = (reason: string) => {
        logAuthEvent('google_oauth_failed', { reason });
        return c.redirect(`${c.env.WEB_BASE_URL}/auth?error=google_oauth_failed`, 302);
    };

    const code = c.req.query('code');
    const state = c.req.query('state');
    const rawCookie = getCookie(c, OAUTH_COOKIE);
    deleteCookie(c, OAUTH_COOKIE, { path: '/v1/auth/google' });
    if (!code || !state || !rawCookie) { return fail('missing_params'); }

    const cookie = await verifyOAuthCookie(rawCookie, c.env.JWT_SECRET);
    if (!cookie || cookie.state !== state) { return fail('state_mismatch'); }

    // Exchange the authorization code; the PKCE verifier binds this exchange
    // to the browser session that started the flow.
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        body: new URLSearchParams({
            code,
            client_id: c.env.GOOGLE_CLIENT_ID!,
            client_secret: c.env.GOOGLE_CLIENT_SECRET!,
            redirect_uri: `${c.env.API_BASE_URL}/v1/auth/google/callback`,
            grant_type: 'authorization_code',
            code_verifier: cookie.pkce_verifier,
        }),
    });
    if (!tokenRes.ok) { return fail('token_exchange'); }
    const { id_token } = await tokenRes.json() as { id_token?: string };
    if (!id_token) { return fail('no_id_token'); }

    let claims: { sub: string; email: string; email_verified?: boolean; nonce?: string };
    try {
        const { payload } = await jwtVerify(id_token, GOOGLE_JWKS, {
            issuer: ['https://accounts.google.com', 'accounts.google.com'],
            audience: c.env.GOOGLE_CLIENT_ID!,
        });
        claims = payload as unknown as typeof claims;
    } catch {
        return fail('id_token_invalid');
    }
    if (claims.nonce !== cookie.nonce) { return fail('nonce_mismatch'); }
    if (claims.email_verified !== true) { return fail('google_email_unverified'); }

    const db = c.env.arcane_db;
    const user = await resolveGoogleAccount(db, claims.sub, claims.email);
    if (!user) { return fail('link_conflict'); }

    // 60-second single-use handoff code in the query string — never a JWT in
    // a URL. The static site exchanges it via POST /v1/auth/web/exchange.
    await cleanExpiredAuthTokens(db);
    const rawCode = generateToken();
    await createAuthToken(db, {
        userId: user.id, purpose: 'web_login',
        tokenHash: await sha256Hex(rawCode), ttlSeconds: TOKEN_TTL_SECONDS.web_login,
    });
    logAuthEvent('google_login', { userId: user.id });
    return c.redirect(`${c.env.WEB_BASE_URL}${cookie.return_to}?code=${rawCode}`, 302);
});

// ─── Web exchange: one-time code → session JWT ──

authGoogleRouter.post('/v1/auth/web/exchange', async (c) => {
    const { code } = await c.req.json<{ code?: string }>();
    if (typeof code !== 'string' || !code) {
        return c.json({ error: 'invalid_code' }, 400);
    }
    const db = c.env.arcane_db;
    const row = await consumeAuthToken(db, 'web_login', await sha256Hex(code));
    if (!row) {
        return c.json({ error: 'invalid_code' }, 400);
    }
    const user = await findUserById(db, row.user_id);
    if (!user) {
        return c.json({ error: 'invalid_code' }, 400);
    }
    logAuthEvent('web_exchange', { userId: user.id });
    return c.json(await mintAuthResponse(user, c.env.JWT_SECRET));
});
