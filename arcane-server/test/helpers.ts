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
