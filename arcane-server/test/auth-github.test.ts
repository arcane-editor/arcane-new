import { describe, it, expect, vi } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { jwtVerify } from 'jose';
import {
    resolveGitHubAccount, fetchGitHubIdentity, exchangeGitHubCode, authGithubRouter,
} from '../src/routes/auth-github.ts';
import { findUserByEmail } from '../src/lib/db.ts';
import { seedPasswordUser, seedGitHubOnlyUser, seedGoogleOnlyUser, tokenFor, jsonPost } from './helpers.ts';

const githubEnv = () => ({
    arcane_db: env.arcane_db,
    JWT_SECRET: env.JWT_SECRET,
    WEB_BASE_URL: env.WEB_BASE_URL,
    API_BASE_URL: env.API_BASE_URL,
    GITHUB_CLIENT_ID: 'test-client-id',
    GITHUB_CLIENT_SECRET: 'test-client-secret',
});

describe('resolveGitHubAccount', () => {
    it('logs in an existing user by github_id', async () => {
        const existing = await seedGitHubOnlyUser('byid@test.dev', '1001');
        const user = await resolveGitHubAccount(env.arcane_db, '1001', 'different@test.dev');
        expect(user?.id).toBe(existing.id);
    });

    it('links by email when the account has no github_id (and marks verified)', async () => {
        const existing = await seedPasswordUser('ghlink@test.dev', 'password123', { verified: false });
        const user = await resolveGitHubAccount(env.arcane_db, '1002', 'ghlink@test.dev');
        expect(user?.id).toBe(existing.id);
        expect(user?.github_id).toBe('1002');
        expect(user?.email_verified).toBe(1);
    });

    it('creates a verified passwordless user when nothing matches', async () => {
        const user = await resolveGitHubAccount(env.arcane_db, '1003', 'ghfresh@test.dev');
        expect(user?.password_hash).toBe('');
        expect(user?.github_id).toBe('1003');
        expect(user?.email_verified).toBe(1);
        expect((await findUserByEmail(env.arcane_db, 'ghfresh@test.dev'))?.id).toBe(user?.id);
    });

    it('refuses when the email is linked to a DIFFERENT GitHub account', async () => {
        await seedGitHubOnlyUser('ghconflict@test.dev', '1004');
        const user = await resolveGitHubAccount(env.arcane_db, '9999', 'ghconflict@test.dev');
        expect(user).toBeNull();
    });

    it('clears the password and revokes sessions when linking onto an UNVERIFIED row (pre-account-takeover)', async () => {
        const attacker = await seedPasswordUser('ghtakeover@test.dev', 'attackerpass1', { verified: false });
        const preLinkJwt = await tokenFor(attacker);

        const user = await resolveGitHubAccount(env.arcane_db, '1005', 'ghtakeover@test.dev');
        expect(user?.id).toBe(attacker.id);
        expect(user?.github_id).toBe('1005');
        expect(user?.email_verified).toBe(1);
        expect(user?.password_hash).toBe('');
        expect(user?.salt).toBe('');
        expect(user?.token_version).toBe(attacker.token_version + 1);

        // The attacker's pre-link session must not survive the link.
        const stale = await jsonPost('/v1/auth/resend-verification', {}, preLinkJwt);
        expect(stale.status).toBe(401);
    });

    it('keeps the password and session live when linking onto an ALREADY-VERIFIED row', async () => {
        const existing = await seedPasswordUser('ghverified@test.dev', 'password123', { verified: true });
        const preLinkJwt = await tokenFor(existing);

        const user = await resolveGitHubAccount(env.arcane_db, '1006', 'ghverified@test.dev');
        expect(user?.id).toBe(existing.id);
        expect(user?.github_id).toBe('1006');
        expect(user?.password_hash).toBe(existing.password_hash);
        expect(user?.salt).toBe(existing.salt);
        expect(user?.token_version).toBe(existing.token_version);

        const live = await jsonPost('/v1/auth/resend-verification', {}, preLinkJwt);
        expect(live.status).toBe(200);
    });

    it('links GitHub onto a Google account with the same verified email (both providers coexist)', async () => {
        const existing = await seedGoogleOnlyUser('bothproviders@test.dev', 'sub-both');
        const user = await resolveGitHubAccount(env.arcane_db, '1007', 'bothproviders@test.dev');
        expect(user?.id).toBe(existing.id);
        expect(user?.google_sub).toBe('sub-both');
        expect(user?.github_id).toBe('1007');
    });
});

// ─── fetchGitHubIdentity ────────────────────────────────────────────────────
// GitHub is not OIDC: identity comes from two authenticated REST calls rather
// than a signed ID token, so it is injected-fetch tested rather than networked.

interface StubRoute { status?: number; body: unknown }

/** Fake fetch routing on URL; records every request for header assertions. */
function stubFetch(routes: { user?: StubRoute; emails?: StubRoute }) {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = Object.fromEntries(new Headers(init?.headers).entries());
        calls.push({ url, headers });
        const route = url.endsWith('/user/emails') ? routes.emails : routes.user;
        if (!route) { return new Response('not stubbed', { status: 500 }); }
        return new Response(JSON.stringify(route.body), {
            status: route.status ?? 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }) as unknown as typeof fetch;
    return { impl, calls };
}

const OK_USER = { user: { body: { id: 4242, login: 'octocat' } } };

describe('fetchGitHubIdentity', () => {
    it('returns the numeric id as a string plus the primary verified email', async () => {
        const { impl } = stubFetch({
            ...OK_USER,
            emails: { body: [
                { email: 'other@test.dev', primary: false, verified: true },
                { email: 'primary@test.dev', primary: true, verified: true },
            ] },
        });
        const result = await fetchGitHubIdentity('gho_token', impl);
        expect(result).toEqual({ ok: true, identity: { id: '4242', email: 'primary@test.dev' } });
    });

    it('sends the bearer token and a User-Agent on both calls (GitHub 403s without a UA)', async () => {
        const { impl, calls } = stubFetch({
            ...OK_USER,
            emails: { body: [{ email: 'ua@test.dev', primary: true, verified: true }] },
        });
        await fetchGitHubIdentity('gho_token', impl);

        expect(calls.map(c => c.url)).toEqual([
            'https://api.github.com/user',
            'https://api.github.com/user/emails',
        ]);
        for (const call of calls) {
            expect(call.headers.authorization).toBe('Bearer gho_token');
            expect(call.headers['user-agent']).toBeTruthy();
        }
    });

    it('refuses a primary email GitHub has not verified', async () => {
        const { impl } = stubFetch({
            ...OK_USER,
            emails: { body: [
                { email: 'unverified@test.dev', primary: true, verified: false },
                { email: 'secondary@test.dev', primary: false, verified: true },
            ] },
        });
        // The verified secondary must NOT be substituted — the account's
        // canonical address is the primary one, and silently binding to
        // another lets the caller choose which identity they land on.
        expect(await fetchGitHubIdentity('gho_token', impl))
            .toEqual({ ok: false, reason: 'no_verified_primary_email' });
    });

    it('refuses when no email is marked primary', async () => {
        const { impl } = stubFetch({
            ...OK_USER,
            emails: { body: [{ email: 'only@test.dev', primary: false, verified: true }] },
        });
        expect(await fetchGitHubIdentity('gho_token', impl))
            .toEqual({ ok: false, reason: 'no_verified_primary_email' });
    });

    it('reports a failed /user call', async () => {
        const { impl } = stubFetch({ user: { status: 401, body: { message: 'Bad credentials' } } });
        expect(await fetchGitHubIdentity('gho_token', impl))
            .toEqual({ ok: false, reason: 'user_fetch_failed' });
    });

    it('reports a /user response with no usable id', async () => {
        const { impl } = stubFetch({ user: { body: { login: 'octocat' } } });
        expect(await fetchGitHubIdentity('gho_token', impl))
            .toEqual({ ok: false, reason: 'user_fetch_failed' });
    });

    it('reports a failure instead of throwing when GitHub returns a non-JSON body', async () => {
        // A 200 with an HTML error/maintenance page must not escape as an
        // unhandled parse throw — the callback has to keep its redirect path.
        const impl = (async () => new Response('<html>unavailable</html>', {
            status: 200, headers: { 'Content-Type': 'text/html' },
        })) as unknown as typeof fetch;
        expect(await fetchGitHubIdentity('gho_token', impl))
            .toEqual({ ok: false, reason: 'user_fetch_failed' });
    });

    it('reports a failed /user/emails call', async () => {
        const { impl } = stubFetch({
            ...OK_USER,
            emails: { status: 403, body: { message: 'Forbidden' } },
        });
        expect(await fetchGitHubIdentity('gho_token', impl))
            .toEqual({ ok: false, reason: 'emails_fetch_failed' });
    });
});

// ─── exchangeGitHubCode ─────────────────────────────────────────────────────

describe('exchangeGitHubCode', () => {
    const params = { code: 'abc', clientId: 'cid', clientSecret: 'csec', redirectUri: 'https://api.test/cb' };

    it('returns the access token and asks for a JSON response', async () => {
        let seen: { url: string; headers: Record<string, string>; body: string } | null = null;
        const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
            seen = {
                url: String(input),
                headers: Object.fromEntries(new Headers(init?.headers).entries()),
                body: String(init?.body),
            };
            return Response.json({ access_token: 'gho_abc', token_type: 'bearer' });
        }) as unknown as typeof fetch;

        expect(await exchangeGitHubCode(params, impl)).toEqual({ ok: true, accessToken: 'gho_abc' });
        expect(seen!.url).toBe('https://github.com/login/oauth/access_token');
        // Without Accept: application/json GitHub answers form-encoded.
        expect(seen!.headers.accept).toBe('application/json');
        const sent = new URLSearchParams(seen!.body);
        expect(sent.get('code')).toBe('abc');
        expect(sent.get('client_id')).toBe('cid');
        expect(sent.get('client_secret')).toBe('csec');
        expect(sent.get('redirect_uri')).toBe('https://api.test/cb');
    });

    it('treats a 200 response carrying an error field as a failure', async () => {
        // GitHub answers HTTP 200 for a bad/expired code — only the body says
        // otherwise. Trusting res.ok alone would carry an undefined token on.
        const impl = (async () => Response.json({
            error: 'bad_verification_code',
            error_description: 'The code passed is incorrect or expired.',
        })) as unknown as typeof fetch;
        expect(await exchangeGitHubCode(params, impl)).toEqual({ ok: false });
    });

    it('fails when the response carries no access token', async () => {
        const impl = (async () => Response.json({ token_type: 'bearer' })) as unknown as typeof fetch;
        expect(await exchangeGitHubCode(params, impl)).toEqual({ ok: false });
    });

    it('fails on a non-2xx response', async () => {
        const impl = (async () => new Response('nope', { status: 502 })) as unknown as typeof fetch;
        expect(await exchangeGitHubCode(params, impl)).toEqual({ ok: false });
    });

    it('fails instead of throwing on a non-JSON body', async () => {
        const impl = (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch;
        expect(await exchangeGitHubCode(params, impl)).toEqual({ ok: false });
    });
});

// ─── GET /v1/auth/github/start ──────────────────────────────────────────────

describe('GET /v1/auth/github/start', () => {
    it('302s to GitHub with state + scopes and sets the signed cookie', async () => {
        const res = await authGithubRouter.request(
            '/v1/auth/github/start?return_to=/account', {}, githubEnv());
        expect(res.status).toBe(302);
        const loc = new URL(res.headers.get('Location')!);
        expect(loc.origin + loc.pathname).toBe('https://github.com/login/oauth/authorize');
        expect(loc.searchParams.get('client_id')).toBe('test-client-id');
        expect(loc.searchParams.get('redirect_uri')).toBe(`${env.API_BASE_URL}/v1/auth/github/callback`);
        expect(loc.searchParams.get('scope')).toBe('read:user user:email');
        expect(loc.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
        // GitHub OAuth Apps do not implement PKCE — the signed state cookie is
        // the CSRF binding. Sending a dead code_challenge would be misleading.
        expect(loc.searchParams.get('code_challenge')).toBeNull();

        const cookie = res.headers.get('Set-Cookie')!;
        expect(cookie).toContain('gh_oauth=');
        expect(cookie).toContain('HttpOnly');
        expect(cookie).toContain('Secure');
        expect(cookie).toContain('Path=/v1/auth/github');
        expect(cookie).toContain('SameSite=Lax');
        expect(cookie).toContain('Max-Age=600');
    });

    it('carries an allowlisted return_to inside the signed cookie, not the query string', async () => {
        const res = await authGithubRouter.request(
            '/v1/auth/github/start?return_to=/account', {}, githubEnv());
        const jwt = res.headers.get('Set-Cookie')!.split(';')[0]!.replace('gh_oauth=', '');
        const { payload } = await jwtVerify(jwt, new TextEncoder().encode(env.JWT_SECRET), {
            issuer: 'arcane-server-github-oauth',
        });
        expect(payload.return_to).toBe('/account');
        expect(payload.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('falls back to /auth for a non-allowlisted return_to', async () => {
        const res = await authGithubRouter.request(
            '/v1/auth/github/start?return_to=https://evil.example/x', {}, githubEnv());
        const jwt = res.headers.get('Set-Cookie')!.split(';')[0]!.replace('gh_oauth=', '');
        const { payload } = await jwtVerify(jwt, new TextEncoder().encode(env.JWT_SECRET), {
            issuer: 'arcane-server-github-oauth',
        });
        expect(payload.return_to).toBe('/auth');
    });

    it('302s to the website error page when the GitHub secrets are unset', async () => {
        const res = await authGithubRouter.request('/v1/auth/github/start', {},
            { ...githubEnv(), GITHUB_CLIENT_ID: undefined, GITHUB_CLIENT_SECRET: undefined });
        expect(res.status).toBe(302);
        expect(res.headers.get('Location')).toBe(`${env.WEB_BASE_URL}/auth?error=github_not_configured`);
    });
});

// ─── GET /v1/auth/github/callback (no-network failure paths) ────────────────

describe('GET /v1/auth/github/callback', () => {
    const failUrl = () => `${env.WEB_BASE_URL}/auth?error=github_oauth_failed`;

    it('redirects to the error page when the cookie is missing', async () => {
        const res = await authGithubRouter.request(
            '/v1/auth/github/callback?code=x&state=y', {}, githubEnv());
        expect(res.status).toBe(302);
        expect(res.headers.get('Location')).toBe(failUrl());
    });

    it('redirects to the error page on state mismatch', async () => {
        const start = await authGithubRouter.request('/v1/auth/github/start', {}, githubEnv());
        const cookieValue = start.headers.get('Set-Cookie')!.split(';')[0]!;
        const res = await authGithubRouter.request(
            '/v1/auth/github/callback?code=x&state=WRONG',
            { headers: { Cookie: cookieValue } }, githubEnv());
        expect(res.status).toBe(302);
        expect(res.headers.get('Location')).toBe(failUrl());
    });

    it('redirects to the error page when GitHub returns no code', async () => {
        const start = await authGithubRouter.request('/v1/auth/github/start', {}, githubEnv());
        const cookieValue = start.headers.get('Set-Cookie')!.split(';')[0]!;
        const res = await authGithubRouter.request(
            '/v1/auth/github/callback?error=access_denied',
            { headers: { Cookie: cookieValue } }, githubEnv());
        expect(res.status).toBe(302);
        expect(res.headers.get('Location')).toBe(failUrl());
    });

    it('clears the state cookie on the way out so it cannot be replayed', async () => {
        const start = await authGithubRouter.request('/v1/auth/github/start', {}, githubEnv());
        const cookieValue = start.headers.get('Set-Cookie')!.split(';')[0]!;
        const res = await authGithubRouter.request(
            '/v1/auth/github/callback?code=x&state=WRONG',
            { headers: { Cookie: cookieValue } }, githubEnv());
        expect(res.headers.get('Set-Cookie')).toContain('gh_oauth=');
        expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
    });
});

// ─── Wiring: the router must actually be mounted on the app ─────────────────

describe('app wiring', () => {
    it('serves /v1/auth/github/start through the worker', async () => {
        // The test env provisions no GitHub secrets, so a mounted route
        // answers with the not-configured redirect; an unmounted one 404s.
        const res = await SELF.fetch('https://example.com/v1/auth/github/start', { redirect: 'manual' });
        expect(res.status).toBe(302);
        expect(res.headers.get('Location')).toBe(`${env.WEB_BASE_URL}/auth?error=github_not_configured`);
    });

    it('serves /v1/auth/github/callback through the worker', async () => {
        const res = await SELF.fetch('https://example.com/v1/auth/github/callback?code=x&state=y', { redirect: 'manual' });
        expect(res.status).toBe(302);
        expect(res.headers.get('Location')).toBe(`${env.WEB_BASE_URL}/auth?error=github_oauth_failed`);
    });
});

// ─── Callback, end to end (global fetch stubbed) ───────────────────────────

/** Stands in for GitHub's token endpoint + REST API for a whole callback. */
function fakeGitHub(opts: { id: number; email: string; verified?: boolean }) {
    return (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === 'https://github.com/login/oauth/access_token') {
            return Response.json({ access_token: 'gho_e2e', token_type: 'bearer' });
        }
        if (url === 'https://api.github.com/user') {
            return Response.json({ id: opts.id, login: 'octocat' });
        }
        if (url === 'https://api.github.com/user/emails') {
            return Response.json([{ email: opts.email, primary: true, verified: opts.verified !== false }]);
        }
        return new Response('unexpected call', { status: 500 });
    }) as unknown as typeof fetch;
}

/** Runs start → callback with a matching state cookie, GitHub stubbed out. */
async function runCallback(github: typeof fetch): Promise<Response> {
    const start = await authGithubRouter.request('/v1/auth/github/start', {}, githubEnv());
    const cookieValue = start.headers.get('Set-Cookie')!.split(';')[0]!;
    const state = new URL(start.headers.get('Location')!).searchParams.get('state')!;
    vi.stubGlobal('fetch', github);
    try {
        return await authGithubRouter.request(
            `/v1/auth/github/callback?code=abc&state=${state}`,
            { headers: { Cookie: cookieValue } }, githubEnv());
    } finally {
        vi.unstubAllGlobals();
    }
}

describe('GET /v1/auth/github/callback (full flow)', () => {
    it('creates the account and hands back a single-use web_login code', async () => {
        const res = await runCallback(fakeGitHub({ id: 5150, email: 'e2e@test.dev' }));
        expect(res.status).toBe(302);

        const loc = new URL(res.headers.get('Location')!);
        expect(loc.origin + loc.pathname).toBe(`${env.WEB_BASE_URL}/auth`);
        const oneTime = loc.searchParams.get('code')!;
        expect(oneTime).toMatch(/^[A-Za-z0-9_-]{43}$/);

        // The handoff code must exchange for a session on the resolved
        // account — and only once.
        const exchange = await jsonPost('/v1/auth/web/exchange', { code: oneTime });
        expect(exchange.status).toBe(200);
        const body = await exchange.json<{ user: { email: string; emailVerified: boolean } }>();
        expect(body.user.email).toBe('e2e@test.dev');
        expect(body.user.emailVerified).toBe(true);
        expect((await jsonPost('/v1/auth/web/exchange', { code: oneTime })).status).toBe(400);
    });

    it('honours the allowlisted return_to captured at start', async () => {
        const start = await authGithubRouter.request(
            '/v1/auth/github/start?return_to=/account', {}, githubEnv());
        const cookieValue = start.headers.get('Set-Cookie')!.split(';')[0]!;
        const state = new URL(start.headers.get('Location')!).searchParams.get('state')!;
        vi.stubGlobal('fetch', fakeGitHub({ id: 5151, email: 'e2eret@test.dev' }));
        try {
            const res = await authGithubRouter.request(
                `/v1/auth/github/callback?code=abc&state=${state}`,
                { headers: { Cookie: cookieValue } }, githubEnv());
            expect(new URL(res.headers.get('Location')!).pathname).toBe('/account');
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('sends the user to a fixable error when GitHub has no verified primary email', async () => {
        const res = await runCallback(fakeGitHub({ id: 5152, email: 'unver@test.dev', verified: false }));
        expect(res.headers.get('Location')).toBe(`${env.WEB_BASE_URL}/auth?error=github_email_unverified`);
    });

    it('names the conflict when the email belongs to a different GitHub account', async () => {
        await seedGitHubOnlyUser('e2econflict@test.dev', '7777');
        const res = await runCallback(fakeGitHub({ id: 6666, email: 'e2econflict@test.dev' }));
        expect(res.headers.get('Location')).toBe(`${env.WEB_BASE_URL}/auth?error=github_account`);
    });

    it('reports a failure when the token exchange is rejected', async () => {
        const rejecting = (async (input: RequestInfo | URL) => {
            if (String(input) === 'https://github.com/login/oauth/access_token') {
                // GitHub's 200-with-error quirk, exercised through the route.
                return Response.json({ error: 'bad_verification_code' });
            }
            return new Response('should not be reached', { status: 500 });
        }) as unknown as typeof fetch;
        const res = await runCallback(rejecting);
        expect(res.headers.get('Location')).toBe(`${env.WEB_BASE_URL}/auth?error=github_oauth_failed`);
    });
});
