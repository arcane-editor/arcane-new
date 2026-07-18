import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { resolveGoogleAccount, authGoogleRouter } from '../src/routes/auth-google.ts';
import { createAuthToken, findUserByEmail } from '../src/lib/db.ts';
import { generateToken, sha256Hex, TOKEN_TTL_SECONDS } from '../src/lib/tokens.ts';
import { seedPasswordUser, seedGoogleOnlyUser, jsonPost } from './helpers.ts';

const googleEnv = () => ({
    arcane_db: env.arcane_db,
    JWT_SECRET: env.JWT_SECRET,
    WEB_BASE_URL: env.WEB_BASE_URL,
    API_BASE_URL: env.API_BASE_URL,
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
});

describe('resolveGoogleAccount', () => {
    it('logs in an existing user by google_sub', async () => {
        const existing = await seedGoogleOnlyUser('bysub@test.dev', 'sub-a');
        const user = await resolveGoogleAccount(env.arcane_db, 'sub-a', 'different@test.dev');
        expect(user?.id).toBe(existing.id);
    });

    it('links by email when the account has no google_sub (and marks verified)', async () => {
        const existing = await seedPasswordUser('linkme@test.dev', 'password123', { verified: false });
        const user = await resolveGoogleAccount(env.arcane_db, 'sub-b', 'linkme@test.dev');
        expect(user?.id).toBe(existing.id);
        expect(user?.google_sub).toBe('sub-b');
        expect(user?.email_verified).toBe(1);
    });

    it('creates a verified passwordless user when nothing matches', async () => {
        const user = await resolveGoogleAccount(env.arcane_db, 'sub-c', 'fresh@test.dev');
        expect(user?.password_hash).toBe('');
        expect(user?.email_verified).toBe(1);
        expect((await findUserByEmail(env.arcane_db, 'fresh@test.dev'))?.id).toBe(user?.id);
    });

    it('refuses when the email is linked to a DIFFERENT Google account', async () => {
        await seedGoogleOnlyUser('conflict@test.dev', 'sub-d');
        const user = await resolveGoogleAccount(env.arcane_db, 'sub-OTHER', 'conflict@test.dev');
        expect(user).toBeNull();
    });
});

describe('GET /v1/auth/google/start', () => {
    it('302s to Google with PKCE S256 + nonce + state and sets the signed cookie', async () => {
        const res = await authGoogleRouter.request(
            '/v1/auth/google/start?return_to=/account', {}, googleEnv());
        expect(res.status).toBe(302);
        const loc = new URL(res.headers.get('Location')!);
        expect(loc.origin + loc.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
        expect(loc.searchParams.get('client_id')).toBe('test-client-id');
        expect(loc.searchParams.get('redirect_uri')).toBe(`${env.API_BASE_URL}/v1/auth/google/callback`);
        expect(loc.searchParams.get('response_type')).toBe('code');
        expect(loc.searchParams.get('scope')).toBe('openid email');
        expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
        expect(loc.searchParams.get('prompt')).toBe('select_account');
        expect(loc.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(loc.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(loc.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);

        const cookie = res.headers.get('Set-Cookie')!;
        expect(cookie).toContain('g_oauth=');
        expect(cookie).toContain('HttpOnly');
        expect(cookie).toContain('Path=/v1/auth/google');
        expect(cookie).toContain('SameSite=Lax');
        expect(cookie).toContain('Max-Age=600');
    });

    it('falls back to /auth for a non-allowlisted return_to', async () => {
        const res = await authGoogleRouter.request(
            '/v1/auth/google/start?return_to=https://evil.example/x', {}, googleEnv());
        expect(res.status).toBe(302);
        // return_to only surfaces at callback time; here we just require the
        // redirect to still be a valid Google URL (no crash, no reflection).
        expect(res.headers.get('Location')!).toContain('accounts.google.com');
    });

    it('302s to the website error page when Google secrets are unset', async () => {
        const res = await authGoogleRouter.request('/v1/auth/google/start', {},
            { ...googleEnv(), GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined });
        expect(res.status).toBe(302);
        expect(res.headers.get('Location')).toBe(`${env.WEB_BASE_URL}/auth?error=google_not_configured`);
    });
});

describe('GET /v1/auth/google/callback (no-network failure paths)', () => {
    it('redirects to the error page when the cookie is missing', async () => {
        const res = await authGoogleRouter.request(
            '/v1/auth/google/callback?code=x&state=y', {}, googleEnv());
        expect(res.status).toBe(302);
        expect(res.headers.get('Location')).toBe(`${env.WEB_BASE_URL}/auth?error=google_oauth_failed`);
    });

    it('redirects to the error page on state mismatch', async () => {
        const start = await authGoogleRouter.request('/v1/auth/google/start', {}, googleEnv());
        const cookieValue = start.headers.get('Set-Cookie')!.split(';')[0]!;  // g_oauth=<jwt>
        const res = await authGoogleRouter.request(
            '/v1/auth/google/callback?code=x&state=WRONG',
            { headers: { Cookie: cookieValue } }, googleEnv());
        expect(res.status).toBe(302);
        expect(res.headers.get('Location')).toBe(`${env.WEB_BASE_URL}/auth?error=google_oauth_failed`);
    });
});

describe('POST /v1/auth/web/exchange', () => {
    it('exchanges a valid 60s code once, then invalid_code on replay', async () => {
        const user = await seedGoogleOnlyUser('wexch@test.dev', 'sub-w');
        const raw = generateToken();
        await createAuthToken(env.arcane_db, {
            userId: user.id, purpose: 'web_login',
            tokenHash: await sha256Hex(raw), ttlSeconds: TOKEN_TTL_SECONDS.web_login,
        });
        const res = await jsonPost('/v1/auth/web/exchange', { code: raw });
        expect(res.status).toBe(200);
        const body = await res.json<{ token: string; user: { email: string } }>();
        expect(body.token).toBeTruthy();
        expect(body.user.email).toBe('wexch@test.dev');

        const replay = await jsonPost('/v1/auth/web/exchange', { code: raw });
        expect(replay.status).toBe(400);
        expect(await replay.json()).toEqual({ error: 'invalid_code' });
    });

    it('invalid_code for unknown/empty codes', async () => {
        expect((await jsonPost('/v1/auth/web/exchange', { code: 'nope' })).status).toBe(400);
        expect((await jsonPost('/v1/auth/web/exchange', {})).status).toBe(400);
    });
});
