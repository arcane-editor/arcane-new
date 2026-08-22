import { env, SELF } from 'cloudflare:test';
import { hashPassword } from '../src/lib/crypto.ts';
import { signJwt, makeJwtPayloadFromUser } from '../src/middleware/auth.ts';
import type { UserRow } from '../src/lib/db.ts';

/** Password user; verified by default (pass {verified:false} for signup-fresh state). */
export async function seedPasswordUser(
    email: string, password: string, opts: { verified?: boolean } = {},
): Promise<UserRow> {
    const { hash, salt } = await hashPassword(password);
    const row = await env.arcane_db.prepare(
        'INSERT INTO users (email, password_hash, salt, email_verified) VALUES (?, ?, ?, ?) RETURNING *'
    ).bind(email.toLowerCase(), hash, salt, opts.verified === false ? 0 : 1).first<UserRow>();
    return row!;
}

export async function seedGoogleOnlyUser(email: string, googleSub: string): Promise<UserRow> {
    const row = await env.arcane_db.prepare(
        "INSERT INTO users (email, password_hash, salt, email_verified, google_sub) VALUES (?, '', '', 1, ?) RETURNING *"
    ).bind(email.toLowerCase(), googleSub).first<UserRow>();
    return row!;
}

export async function seedGitHubOnlyUser(email: string, githubId: string): Promise<UserRow> {
    const row = await env.arcane_db.prepare(
        "INSERT INTO users (email, password_hash, salt, email_verified, github_id) VALUES (?, '', '', 1, ?) RETURNING *"
    ).bind(email.toLowerCase(), githubId).first<UserRow>();
    return row!;
}

/** Current-claims JWT for a seeded user (same mint path as the server). */
export async function tokenFor(user: UserRow): Promise<string> {
    return signJwt(makeJwtPayloadFromUser(user), env.JWT_SECRET);
}

export function jsonPost(path: string, body: unknown, token?: string): Promise<Response> {
    return SELF.fetch(`https://example.com${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
    });
}

export function jsonPut(path: string, body: unknown, token?: string): Promise<Response> {
    return SELF.fetch(`https://example.com${path}`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
    });
}

/** GET with a bearer token — the common shape for authed admin/usage reads. */
export function authedGet(path: string, token: string): Promise<Response> {
    return SELF.fetch(`https://example.com${path}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
}

/** DB-role admin token (role='admin' user row) — the success-path credential
 *  for /v1/admin/* routes, distinct from the env-admin token minted by
 *  POST /v1/admin/login (Task 6). Shared here so every admin test file uses
 *  the same seeding shape. */
export async function adminToken(): Promise<string> {
    const admin = await seedPasswordUser(`adm-${crypto.randomUUID()}@test.dev`, 'adminpass123');
    const row = await env.arcane_db.prepare(
        "UPDATE users SET role = 'admin' WHERE id = ? RETURNING *"
    ).bind(admin.id).first<UserRow>();
    return tokenFor(row!);
}
