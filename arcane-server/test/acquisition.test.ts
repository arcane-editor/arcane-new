import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { jwtVerify } from 'jose';
import { acquisitionFrom, acquisitionFromQuery, recordAcquisition } from '../src/lib/acquisition.ts';
import { authGoogleRouter } from '../src/routes/auth-google.ts';
import { authGithubRouter } from '../src/routes/auth-github.ts';
import { jsonPost, seedPasswordUser } from './helpers.ts';

const ACQUISITION = { source: 'google', medium: 'organic', landingPath: '/blog/unity-ide/', referrerHost: 'www.google.com' };
const QUERY = new URLSearchParams({ acq_source: 'google', acq_medium: 'organic', acq_landing_path: ACQUISITION.landingPath, acq_referrer_host: ACQUISITION.referrerHost }).toString();

describe('coarse acquisition validation', () => {
    it('accepts clean marketing dimensions and normalizes case', () => {
        expect(acquisitionFrom({ ...ACQUISITION, source: 'Google', referrerHost: 'WWW.GOOGLE.COM' })).toEqual(ACQUISITION);
        expect(acquisitionFromQuery(`https://example.com/start?${QUERY}`)).toEqual(ACQUISITION);
        expect(acquisitionFrom({ source: 'direct', medium: 'none', landingPath: '/' })).toEqual({ source: 'direct', medium: 'none', landingPath: '/' });
    });
    it.each(['/auth', '/auth/success/', '/account', '/verify', '/reset', '//evil.test', '/blog/x?token=abc', '/blog/x#private', '/a/../auth', '/%61uth', 'https://site.test/blog'])('rejects private or non-path landing value %s', (landingPath) => {
        expect(acquisitionFrom({ ...ACQUISITION, landingPath })).toBeNull();
    });
    it('rejects full referrer URLs, PII-shaped source, and oversized input without inventing organic', () => {
        expect(acquisitionFrom(null)).toBeNull();
        expect(acquisitionFrom({ ...ACQUISITION, referrerHost: 'https://google.com?q=private' })).toBeNull();
        expect(acquisitionFrom({ ...ACQUISITION, source: 'me@example.com' })).toBeNull();
        expect(acquisitionFrom({ ...ACQUISITION, source: 'a'.repeat(65) })).toBeNull();
    });
});

describe('signup acquisition persistence', () => {
    it('captures password signup, leaves Reddit attribution intact and does not capture malformed acquisition', async () => {
        const res = await jsonPost('/v1/auth/signup', { email: 'acquisition-new@test.dev', password: 'password123', acquisition: ACQUISITION, rdtCid: 'existing-reddit-click' });
        expect(res.status).toBe(200);
        const { user } = await res.json<{ user: { id: number } }>();
        const row = await env.arcane_db.prepare('SELECT * FROM user_acquisition WHERE user_id = ?').bind(user.id).first<Record<string, unknown>>();
        expect(row?.source).toBe('google');
        expect(row?.landing_path).toBe(ACQUISITION.landingPath);
        expect((await env.arcane_db.prepare('SELECT rdt_click_id FROM users WHERE id = ?').bind(user.id).first<{ rdt_click_id: string }>())?.rdt_click_id).toBe('existing-reddit-click');
        await recordAcquisition(env.arcane_db, user.id, { ...ACQUISITION, source: 'bing' });
        expect((await env.arcane_db.prepare('SELECT source FROM user_acquisition WHERE user_id = ?').bind(user.id).first<{ source: string }>())?.source).toBe('google');
        const second = await seedPasswordUser('acquisition-unknown@test.dev', 'password123');
        await recordAcquisition(env.arcane_db, second.id, { ...ACQUISITION, landingPath: '/auth' });
        expect(await env.arcane_db.prepare('SELECT * FROM user_acquisition WHERE user_id = ?').bind(second.id).first()).toBeNull();
    });

    it.each(['google', 'github'] as const)('carries validated acquisition inside signed %s OAuth state', async (provider) => {
        const router = provider === 'google' ? authGoogleRouter : authGithubRouter;
        const oauthEnv = { arcane_db: env.arcane_db, JWT_SECRET: env.JWT_SECRET,
            WEB_BASE_URL: env.WEB_BASE_URL, API_BASE_URL: env.API_BASE_URL,
            GOOGLE_CLIENT_ID: 'test-id', GOOGLE_CLIENT_SECRET: 'test-secret',
            GITHUB_CLIENT_ID: 'test-id', GITHUB_CLIENT_SECRET: 'test-secret' };
        const res = await router.request(`/v1/auth/${provider}/start?${QUERY}`, {}, oauthEnv);
        const cookie = res.headers.get('Set-Cookie')!.split(';')[0]!.split('=')[1]!;
        const { payload } = await jwtVerify(cookie, new TextEncoder().encode(env.JWT_SECRET));
        expect(payload.acquisition).toEqual(ACQUISITION);
        // The provider authorization URL receives none of the acquisition data.
        expect(res.headers.get('Location')).not.toContain('acq_');
    });
});
