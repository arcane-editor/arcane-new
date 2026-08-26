import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { jwtVerify, SignJWT } from 'jose';
import {
    findUserByGitHubId, findUserByEmail, linkGitHubId, linkGitHubIdClearingCredentials, createOAuthUser,
    createAuthToken, cleanExpiredAuthTokens,
} from '../lib/db.ts';
import type { UserRow } from '../lib/db.ts';
import { generateToken, sha256Hex, TOKEN_TTL_SECONDS } from '../lib/tokens.ts';
import { logAuthEvent } from '../lib/log.ts';
import type { AppEnv } from '../types.ts';

export const authGithubRouter = new Hono<AppEnv>();

const GITHUB_AUTH_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API_URL = 'https://api.github.com';
// GitHub answers 403 to any API request without a User-Agent.
const GITHUB_USER_AGENT = 'arcane-server';
const OAUTH_COOKIE = 'gh_oauth';
const OAUTH_COOKIE_ISSUER = 'arcane-server-github-oauth';
const RETURN_TO_ALLOWLIST = ['/auth', '/account'];

interface OAuthCookiePayload {
    state: string;
    return_to: string;
}

// Same 10-minute HS256 state cookie the Google route uses, under its own
// issuer so neither provider's cookie can be replayed as the other's.
//
// There is no PKCE verifier here: GitHub OAuth Apps do not implement PKCE and
// ignore code_challenge outright. The code exchange is confidential-client
// (it carries the client secret), so the signed state is the CSRF binding.
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
        const { payload } = await jwtVerify(token, secret, { issuer: OAUTH_COOKIE_ISSUER, algorithms: ['HS256'] });
        return payload as unknown as OAuthCookiePayload;
    } catch {
        return null;
    }
}

export type GitHubTokenResult = { ok: true; accessToken: string } | { ok: false };

/**
 * Swap the authorization code for a user access token.
 *
 * GitHub answers HTTP **200** for a bad or expired code and puts the failure in
 * the body (`{"error":"bad_verification_code"}`), so `res.ok` alone is not a
 * success signal. Without `Accept: application/json` the body comes back
 * form-encoded.
 */
export async function exchangeGitHubCode(
    params: { code: string; clientId: string; clientSecret: string; redirectUri: string },
    fetchImpl: typeof fetch = fetch,
): Promise<GitHubTokenResult> {
    const res = await fetchImpl(GITHUB_TOKEN_URL, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': GITHUB_USER_AGENT,
        },
        body: new URLSearchParams({
            code: params.code,
            client_id: params.clientId,
            client_secret: params.clientSecret,
            redirect_uri: params.redirectUri,
        }),
    });
    if (!res.ok) { return { ok: false }; }
    const body = await jsonOrNull<{ access_token?: string; error?: string }>(res);
    if (!body || body.error || typeof body.access_token !== 'string' || !body.access_token) {
        return { ok: false };
    }
    return { ok: true, accessToken: body.access_token };
}

export interface GitHubIdentity {
    id: string;     // GitHub's numeric user id, stringified
    email: string;  // primary AND verified
}

export type GitHubIdentityResult =
    | { ok: true; identity: GitHubIdentity }
    | { ok: false; reason: 'user_fetch_failed' | 'emails_fetch_failed' | 'no_verified_primary_email' };

interface GitHubEmailRow { email?: string; primary?: boolean; verified?: boolean }

/** GitHub can answer 200 with an HTML error/maintenance page. A parse throw
 *  would escape the callback and cost it its redirect handling. */
async function jsonOrNull<T>(res: Response): Promise<T | null> {
    try {
        return await res.json() as T;
    } catch {
        return null;
    }
}

/**
 * GitHub is not OIDC — there is no ID token to verify, so identity comes from
 * two authenticated REST calls made with the freshly-issued access token.
 *
 * Only an email that is BOTH primary and verified is accepted. Substituting a
 * verified secondary when the primary is unverified would let the GitHub user
 * steer which UnityIDE account they land on; refusing is the safe default and is
 * the one failure here a user can fix themselves.
 *
 * fetchImpl is injectable so the whole path is unit-testable without network.
 */
export async function fetchGitHubIdentity(
    accessToken: string, fetchImpl: typeof fetch = fetch,
): Promise<GitHubIdentityResult> {
    const headers = {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': GITHUB_USER_AGENT,
    };

    const userRes = await fetchImpl(`${GITHUB_API_URL}/user`, { headers });
    if (!userRes.ok) { return { ok: false, reason: 'user_fetch_failed' }; }
    const user = await jsonOrNull<{ id?: number }>(userRes);
    if (typeof user?.id !== 'number') { return { ok: false, reason: 'user_fetch_failed' }; }

    const emailsRes = await fetchImpl(`${GITHUB_API_URL}/user/emails`, { headers });
    if (!emailsRes.ok) { return { ok: false, reason: 'emails_fetch_failed' }; }
    const emails = await jsonOrNull<GitHubEmailRow[]>(emailsRes);
    const primary = Array.isArray(emails)
        ? emails.find(e => e?.primary === true && e?.verified === true)
        : undefined;
    if (!primary?.email) { return { ok: false, reason: 'no_verified_primary_email' }; }

    return { ok: true, identity: { id: String(user.id), email: primary.email } };
}

/** Account decision: login by github_id → link by email → create.
 *  Returns null on a link conflict (email already bound to a DIFFERENT
 *  GitHub user). Exported for unit tests. */
export async function resolveGitHubAccount(
    db: D1Database, githubId: string, email: string,
): Promise<UserRow | null> {
    const byId = await findUserByGitHubId(db, githubId);
    if (byId) { return byId; }
    const byEmail = await findUserByEmail(db, email);
    if (byEmail) {
        if (byEmail.github_id && byEmail.github_id !== githubId) {
            return null;
        }
        // An unverified row's password can't be trusted (anyone could have
        // pre-registered the victim's email before they arrived via GitHub),
        // so linking onto it clears the credential and revokes any sessions
        // that password minted. Verified rows keep their password as-is.
        return byEmail.email_verified === 1
            ? linkGitHubId(db, byEmail.id, githubId)
            : linkGitHubIdClearingCredentials(db, byEmail.id, githubId);
    }
    return createOAuthUser(db, { email, githubId });
}

// ─── Start: 302 to GitHub with the state in a signed cookie ──

authGithubRouter.get('/v1/auth/github/start', async (c) => {
    if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET) {
        return c.redirect(`${c.env.WEB_BASE_URL}/auth?error=github_not_configured`, 302);
    }
    const requested = c.req.query('return_to') ?? '/auth';
    const returnTo = RETURN_TO_ALLOWLIST.includes(requested) ? requested : '/auth';

    const state = generateToken();
    const cookie = await signOAuthCookie({ state, return_to: returnTo }, c.env.JWT_SECRET);
    setCookie(c, OAUTH_COOKIE, cookie, {
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        path: '/v1/auth/github',
        maxAge: 600,
    });

    const params = new URLSearchParams({
        client_id: c.env.GITHUB_CLIENT_ID,
        redirect_uri: `${c.env.API_BASE_URL}/v1/auth/github/callback`,
        // read:user for the account id, user:email for the verified address —
        // /user alone omits the email when the profile keeps it private.
        scope: 'read:user user:email',
        state,
        allow_signup: 'true',
    });
    return c.redirect(`${GITHUB_AUTH_URL}?${params}`, 302);
});

// ─── Callback: verify state → token → identity → 60s web_login code ──

authGithubRouter.get('/v1/auth/github/callback', async (c) => {
    const fail = (reason: string, errorCode = 'github_oauth_failed') => {
        logAuthEvent('github_oauth_failed', { reason });
        return c.redirect(`${c.env.WEB_BASE_URL}/auth?error=${errorCode}`, 302);
    };

    const code = c.req.query('code');
    const state = c.req.query('state');
    const rawCookie = getCookie(c, OAUTH_COOKIE);
    // Cleared unconditionally: one authorization round-trip, one cookie.
    deleteCookie(c, OAUTH_COOKIE, { path: '/v1/auth/github' });
    // No code also covers the user pressing Cancel on GitHub's consent screen.
    if (!code || !state || !rawCookie) { return fail('missing_params'); }

    const cookie = await verifyOAuthCookie(rawCookie, c.env.JWT_SECRET);
    if (!cookie || cookie.state !== state) { return fail('state_mismatch'); }
    if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET) {
        return fail('not_configured', 'github_not_configured');
    }

    const token = await exchangeGitHubCode({
        code,
        clientId: c.env.GITHUB_CLIENT_ID,
        clientSecret: c.env.GITHUB_CLIENT_SECRET,
        redirectUri: `${c.env.API_BASE_URL}/v1/auth/github/callback`,
    });
    if (!token.ok) { return fail('token_exchange'); }

    // The access token is used for these two calls and then dropped — UnityIDE
    // signs people in with GitHub, it does not act on GitHub for them.
    const identity = await fetchGitHubIdentity(token.accessToken);
    if (!identity.ok) {
        // Distinct code for the one failure the user can act on themselves.
        return identity.reason === 'no_verified_primary_email'
            ? fail(identity.reason, 'github_email_unverified')
            : fail(identity.reason);
    }

    const db = c.env.arcane_db;
    const user = await resolveGitHubAccount(db, identity.identity.id, identity.identity.email);
    // Naming the conflict leaks nothing: GitHub just verified this caller owns
    // the address, so they are entitled to know it is bound elsewhere — and
    // "use your other GitHub account" is advice they can act on.
    if (!user) { return fail('link_conflict', 'github_account'); }

    // 60-second single-use handoff code in the query string — never a JWT in
    // a URL. The static site exchanges it via POST /v1/auth/web/exchange.
    await cleanExpiredAuthTokens(db);
    const rawCode = generateToken();
    await createAuthToken(db, {
        userId: user.id, purpose: 'web_login',
        tokenHash: await sha256Hex(rawCode), ttlSeconds: TOKEN_TTL_SECONDS.web_login,
    });
    logAuthEvent('github_login', { userId: user.id });
    return c.redirect(`${c.env.WEB_BASE_URL}${cookie.return_to}?code=${rawCode}`, 302);
});
