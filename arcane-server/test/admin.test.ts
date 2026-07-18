import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { seedPasswordUser, tokenFor, jsonPost } from './helpers.ts';
import type { UserRow } from '../src/lib/db.ts';

// jsonPost is POST-only; minimal PUT helper for the admin route.
function SELF_put(path: string, body: unknown, token: string): Promise<Response> {
    return SELF.fetch(`https://example.com${path}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });
}

async function adminToken(): Promise<string> {
    const admin = await seedPasswordUser(`adm-${crypto.randomUUID()}@test.dev`, 'adminpass123');
    const row = await env.arcane_db.prepare(
        "UPDATE users SET role = 'admin' WHERE id = ? RETURNING *"
    ).bind(admin.id).first<UserRow>();
    return tokenFor(row!);
}

describe('admin user management (0012 semantics)', () => {
    it('admin-created users are pre-verified', async () => {
        const token = await adminToken();
        const res = await jsonPost('/v1/admin/users',
            { email: 'made-by-admin@test.dev', password: 'password123' }, token);
        expect(res.status).toBe(201);
        const { id } = await res.json<{ id: number }>();
        const row = await env.arcane_db.prepare('SELECT email_verified FROM users WHERE id = ?')
            .bind(id).first<{ email_verified: number }>();
        expect(row!.email_verified).toBe(1);
    });

    it('admin password set bumps token_version (revokes sessions)', async () => {
        const token = await adminToken();
        const victim = await seedPasswordUser('victim@test.dev', 'password123');
        const victimJwt = await tokenFor(victim);
        const res = await SELF_put(`/v1/admin/users/${victim.id}`, { password: 'newpassword1' }, token);
        expect(res.status).toBe(200);
        const stale = await jsonPost('/v1/auth/resend-verification', {}, victimJwt);
        expect(stale.status).toBe(401);
    });
});
