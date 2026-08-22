import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { seedPasswordUser, tokenFor, jsonPost, jsonPut, adminToken, authedGet } from './helpers.ts';
import { microToCredits } from '../src/config/tiers.ts';

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
        const res = await jsonPut(`/v1/admin/users/${victim.id}`, { password: 'newpassword1' }, token);
        expect(res.status).toBe(200);
        const stale = await jsonPost('/v1/auth/resend-verification', {}, victimJwt);
        expect(stale.status).toBe(401);
    });
});

// Users projection (Task 7): the SELECT already pulled u.* via
// findAllUsersWithUsage — this covers the plan/credits fields added to the
// mapped response.
describe('GET /v1/admin/users — plan/credits projection', () => {
    it('includes plan and credits (microToCredits of plan+topup) per row', async () => {
        const token = await adminToken();
        const target = await seedPasswordUser(`users-list-${crypto.randomUUID()}@test.dev`, 'password123');
        await env.arcane_db.prepare(
            'UPDATE users SET plan = ?, plan_credits_micro = ?, topup_credits_micro = ? WHERE id = ?'
        ).bind('pro', 500_000, 50_000, target.id).run();

        const res = await authedGet('/v1/admin/users', token);
        expect(res.status).toBe(200);
        const users = await res.json<Array<{ id: number; plan: string; credits: number }>>();
        const row = users.find(u => u.id === target.id);
        expect(row).toBeDefined();
        expect(row!.plan).toBe('pro');
        expect(row!.credits).toBe(microToCredits(500_000 + 50_000));
    });
});
