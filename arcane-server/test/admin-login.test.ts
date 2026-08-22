import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { decodeJwt } from 'jose';
import { jsonPost, seedPasswordUser, tokenFor } from './helpers.ts';
import { OWNER_EMAIL } from '../src/routes/admin.ts';
import { digestsMatch } from '../src/lib/crypto.ts';
import app from '../index.ts';

// ADMIN_PASSWORD is set in wrangler.test.toml (see that file's comment on
// why JWT_SECRET etc. are plain vars there).
const REAL_PASSWORD = 'test-admin-password';

async function loginBody(res: Response): Promise<Record<string, unknown>> {
    return res.json();
}

async function loginAsAdmin(): Promise<string> {
    const res = await jsonPost('/v1/admin/login', { email: OWNER_EMAIL, password: REAL_PASSWORD });
    const { token } = await loginBody(res) as { token: string };
    return token;
}

function authedGet(path: string, token: string): Promise<Response> {
    return SELF.fetch(`https://example.com${path}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
}

describe('POST /v1/admin/login', () => {
    it('wrong email + right password -> 401 Invalid credentials', async () => {
        const res = await jsonPost('/v1/admin/login', { email: 'not-the-owner@test.dev', password: REAL_PASSWORD });
        expect(res.status).toBe(401);
        expect(await loginBody(res)).toEqual({ error: 'Invalid credentials' });
    });

    it('right email + wrong password -> 401 Invalid credentials', async () => {
        const res = await jsonPost('/v1/admin/login', { email: OWNER_EMAIL, password: 'not-the-real-password' });
        expect(res.status).toBe(401);
        expect(await loginBody(res)).toEqual({ error: 'Invalid credentials' });
    });

    it('the two failure-mode response bodies are byte-identical', async () => {
        const wrongEmail = await jsonPost('/v1/admin/login', { email: 'nope@test.dev', password: REAL_PASSWORD });
        const wrongPassword = await jsonPost('/v1/admin/login', { email: OWNER_EMAIL, password: 'nope' });
        expect(wrongEmail.status).toBe(wrongPassword.status);
        const [bodyA, bodyB] = await Promise.all([wrongEmail.text(), wrongPassword.text()]);
        expect(bodyA).toBe(bodyB);
    });

    it('wrong email AND wrong password -> the same 401 Invalid credentials', async () => {
        const res = await jsonPost('/v1/admin/login', { email: 'nope@test.dev', password: 'nope' });
        expect(res.status).toBe(401);
        expect(await loginBody(res)).toEqual({ error: 'Invalid credentials' });
    });

    it('400 when email or password is missing/non-string', async () => {
        const missing = await jsonPost('/v1/admin/login', { email: OWNER_EMAIL });
        expect(missing.status).toBe(400);
        const nonString = await jsonPost('/v1/admin/login', { email: OWNER_EMAIL, password: 12345 });
        expect(nonString.status).toBe(400);
    });

    it('503 admin_unconfigured when ADMIN_PASSWORD is unset', async () => {
        const res = await app.request('/v1/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: OWNER_EMAIL, password: REAL_PASSWORD }),
        }, {}); // env override with no ADMIN_PASSWORD binding at all
        expect(res.status).toBe(503);
        expect(await loginBody(res)).toEqual({ error: 'Admin login is not configured', code: 'admin_unconfigured' });
    });

    describe('success', () => {
        it('returns {token}', async () => {
            const res = await jsonPost('/v1/admin/login', { email: OWNER_EMAIL, password: REAL_PASSWORD });
            expect(res.status).toBe(200);
            const body = await loginBody(res);
            expect(typeof body.token).toBe('string');
        });

        it('decoded token claims: adm===true, role===admin, sub===env-admin, ~12h expiry', async () => {
            const res = await jsonPost('/v1/admin/login', { email: OWNER_EMAIL, password: REAL_PASSWORD });
            const { token } = await loginBody(res) as { token: string };
            const claims = decodeJwt(token);
            expect(claims.adm).toBe(true);
            expect(claims.role).toBe('admin');
            expect(claims.sub).toBe('env-admin');
            expect(claims.email).toBe(OWNER_EMAIL);
            expect(claims.iss).toBe('arcane-server');
            const lifetimeSeconds = (claims.exp as number) - (claims.iat as number);
            expect(lifetimeSeconds).toBeLessThanOrEqual(12 * 60 * 60);
            expect(lifetimeSeconds).toBeGreaterThan(11 * 60 * 60); // sanity floor, generous slack
        });

        it('the minted token passes adminAccess (GET /v1/admin/users)', async () => {
            const token = await loginAsAdmin();
            const res = await authedGet('/v1/admin/users', token);
            expect(res.status).toBe(200);
            expect(Array.isArray(await res.json())).toBe(true);
        });

        it('the minted token is rejected by ordinary authMiddleware (GET /v1/usage)', async () => {
            const token = await loginAsAdmin();
            const res = await authedGet('/v1/usage', token);
            // sub='env-admin' is not a numeric user id -> no DB row -> 401.
            // Privilege separation: an env-admin token only works on /v1/admin/*.
            expect(res.status).toBe(401);
        });
    });
});

// Regression coverage for adminAccess() itself (middleware/admin.ts), the
// unified gate this task introduces. test/admin.test.ts stays unchanged as
// the DB-role SUCCESS-path proof; these cover its failure branches.
describe('adminAccess middleware failure branches (via GET /v1/admin/users)', () => {
    it('401 Unauthorized with no Authorization header', async () => {
        const res = await SELF.fetch('https://example.com/v1/admin/users');
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'Unauthorized' });
    });

    it('401 Unauthorized with a garbage bearer token', async () => {
        const res = await authedGet('/v1/admin/users', 'not-a-real-jwt');
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'Unauthorized' });
    });

    it('403 Admin access required for a valid non-admin user token', async () => {
        const user = await seedPasswordUser(`regular-${crypto.randomUUID()}@test.dev`, 'password123');
        const token = await tokenFor(user);
        const res = await authedGet('/v1/admin/users', token);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'Admin access required' });
    });
});

describe('digestsMatch (constant-time digest compare)', () => {
    it('equal strings pass', async () => {
        expect(await digestsMatch('correct-horse-battery-staple', 'correct-horse-battery-staple')).toBe(true);
    });

    it('unequal strings of the same length fail', async () => {
        expect(await digestsMatch('aaaaaaaaaa', 'aaaaaaaaab')).toBe(false);
    });

    it('different-length strings fail without throwing', async () => {
        await expect(digestsMatch('short', 'a-much-longer-string-entirely')).resolves.toBe(false);
    });

    it('empty string vs non-empty fails without throwing', async () => {
        await expect(digestsMatch('', 'nonempty')).resolves.toBe(false);
    });
});
