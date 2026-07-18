import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { seedPasswordUser, seedGoogleOnlyUser, tokenFor, jsonPost } from './helpers.ts';

describe('POST /v1/auth/signup', () => {
    it('creates an unverified user, mints a token, stores a verify_email token', async () => {
        const res = await jsonPost('/v1/auth/signup', { email: 'new@test.dev', password: 'password123' });
        expect(res.status).toBe(200);
        const body = await res.json<{ token: string; user: { id: number; emailVerified: boolean } }>();
        expect(body.token).toBeTruthy();
        expect(body.user.emailVerified).toBe(false);
        const t = await env.arcane_db.prepare(
            "SELECT COUNT(*) AS n FROM auth_tokens WHERE user_id = ? AND purpose = 'verify_email'"
        ).bind(body.user.id).first<{ n: number }>();
        expect(t!.n).toBe(1);
    });

    it('validates email format and password strength', async () => {
        const bad = await jsonPost('/v1/auth/signup', { email: 'not-an-email', password: 'password123' });
        expect(bad.status).toBe(400);
        expect(await bad.json()).toEqual({ error: 'invalid_email' });
        const weak = await jsonPost('/v1/auth/signup', { email: 'ok@test.dev', password: 'short' });
        expect(weak.status).toBe(400);
        expect(await weak.json()).toEqual({ error: 'weak_password' });
    });

    it('409 google_account when the email belongs to a Google-only user', async () => {
        await seedGoogleOnlyUser('taken-g@test.dev', 'sub-signup');
        const res = await jsonPost('/v1/auth/signup', { email: 'taken-g@test.dev', password: 'password123' });
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: 'google_account' });
    });

    it('409 for an existing password account', async () => {
        await seedPasswordUser('taken@test.dev', 'password123');
        const res = await jsonPost('/v1/auth/signup', { email: 'taken@test.dev', password: 'password123' });
        expect(res.status).toBe(409);
    });
});

describe('POST /v1/auth/login', () => {
    it('401 use_google for Google-only accounts', async () => {
        await seedGoogleOnlyUser('glogin@test.dev', 'sub-login');
        const res = await jsonPost('/v1/auth/login', { email: 'glogin@test.dev', password: 'whatever123' });
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'use_google' });
    });

    it('still logs in password users and returns emailVerified', async () => {
        await seedPasswordUser('plogin@test.dev', 'password123');
        const res = await jsonPost('/v1/auth/login', { email: 'plogin@test.dev', password: 'password123' });
        expect(res.status).toBe(200);
        const body = await res.json<{ user: { emailVerified: boolean } }>();
        expect(body.user.emailVerified).toBe(true);
    });
});

describe('GET /v1/auth/me', () => {
    it('returns emailVerified/hasPassword/googleLinked', async () => {
        const user = await seedPasswordUser('me@test.dev', 'password123');
        const res = await SELF.fetch('https://example.com/v1/auth/me', {
            headers: { Authorization: `Bearer ${await tokenFor(user)}` },
        });
        expect(res.status).toBe(200);
        const body = await res.json<{
            user: { emailVerified: boolean }; hasPassword: boolean; googleLinked: boolean;
        }>();
        expect(body.user.emailVerified).toBe(true);
        expect(body.hasPassword).toBe(true);
        expect(body.googleLinked).toBe(false);
    });
});

describe('POST /v1/auth/device/code', () => {
    it('builds verification_uri from WEB_BASE_URL', async () => {
        const res = await jsonPost('/v1/auth/device/code', {});
        expect(res.status).toBe(200);
        const body = await res.json<{ verification_uri: string }>();
        expect(body.verification_uri).toBe('https://dev.arcaneai.org/auth/device');
    });
});
