import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { adminToken, jsonPost, seedPasswordUser, tokenFor } from './helpers.ts';
import { upsertSubscription, type UserRow } from '../src/lib/db.ts';
import { refreshAndGetBalance } from '../src/lib/credits.ts';
import { tierGrantMicro } from '../src/config/tiers.ts';

async function getUserRow(id: number): Promise<UserRow> {
    const row = await env.arcane_db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
    return row!;
}

describe('POST /v1/admin/grants', () => {
    it("grants pro to an existing free user: plan 'pro', plan_credits_micro === tierGrantMicro('pro'), plan_period_end ≈ now+30d, NO subscriptions row", async () => {
        const token = await adminToken();
        const target = await seedPasswordUser(`grant-target-${crypto.randomUUID()}@test.dev`, 'password123');
        expect(target.plan).toBe('free');

        const before = Date.now();
        const res = await jsonPost('/v1/admin/grants', { email: target.email, tier: 'pro' }, token);
        expect(res.status).toBe(200);
        const body = await res.json<{ ok: boolean; userId: number; plan: string; periodEnd: string }>();
        expect(body).toEqual({ ok: true, userId: target.id, plan: 'pro', periodEnd: body.periodEnd });

        const row = await getUserRow(target.id);
        expect(row.plan).toBe('pro');
        expect(row.plan_credits_micro).toBe(tierGrantMicro('pro'));

        const periodEndMs = new Date(row.plan_period_end!).getTime();
        const expectedMs = before + 30 * 24 * 60 * 60 * 1000;
        expect(Math.abs(periodEndMs - expectedMs)).toBeLessThan(10_000); // generous slack

        const sub = await env.arcane_db.prepare('SELECT * FROM subscriptions WHERE user_id = ?')
            .bind(target.id).first();
        expect(sub).toBeNull(); // deliberately no subscriptions row — see lib/db.ts's grantPlanCredits comment
    });

    it('unknown email -> 404 user_not_found', async () => {
        const token = await adminToken();
        const res = await jsonPost('/v1/admin/grants', { email: `nobody-${crypto.randomUUID()}@test.dev`, tier: 'pro' }, token);
        expect(res.status).toBe(404);
        const body = await res.json<{ error: string; code: string }>();
        expect(body.code).toBe('user_not_found');
    });

    it("tier 'free' -> 400 invalid_tier", async () => {
        const token = await adminToken();
        const target = await seedPasswordUser(`grant-free-${crypto.randomUUID()}@test.dev`, 'password123');
        const res = await jsonPost('/v1/admin/grants', { email: target.email, tier: 'free' }, token);
        expect(res.status).toBe(400);
        const body = await res.json<{ error: string; code: string }>();
        expect(body.code).toBe('invalid_tier');
    });

    it('garbage tier -> 400 invalid_tier', async () => {
        const token = await adminToken();
        const target = await seedPasswordUser(`grant-garbage-${crypto.randomUUID()}@test.dev`, 'password123');
        const res = await jsonPost('/v1/admin/grants', { email: target.email, tier: 'not-a-real-tier' }, token);
        expect(res.status).toBe(400);
        const body = await res.json<{ error: string; code: string }>();
        expect(body.code).toBe('invalid_tier');
    });

    it('401 without a token', async () => {
        const res = await SELF.fetch('https://example.com/v1/admin/grants', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'x@test.dev', tier: 'pro' }),
        });
        expect(res.status).toBe(401);
    });

    it('403 with a non-admin user token', async () => {
        const user = await seedPasswordUser(`nonadmin-grants-${crypto.randomUUID()}@test.dev`, 'password123');
        const token = await tokenFor(user);
        const res = await jsonPost('/v1/admin/grants', { email: 'x@test.dev', tier: 'pro' }, token);
        expect(res.status).toBe(403);
    });

    describe('lazy expiry integration', () => {
        it('a granted comp plan reverts to free (0 plan credits, top-ups kept) once plan_period_end is rewound to the past', async () => {
            const token = await adminToken();
            const target = await seedPasswordUser(`grant-expire-${crypto.randomUUID()}@test.dev`, 'password123');
            await env.arcane_db.prepare('UPDATE users SET topup_credits_micro = ? WHERE id = ?')
                .bind(123_000, target.id).run();

            const grant = await jsonPost('/v1/admin/grants', { email: target.email, tier: 'pro' }, token);
            expect(grant.status).toBe(200);

            // SQL-rewind the just-granted period end into the past, simulating
            // a comp plan that has lapsed.
            await env.arcane_db.prepare("UPDATE users SET plan_period_end = '2000-01-01T00:00:00.000Z' WHERE id = ?")
                .bind(target.id).run();

            const bal = await refreshAndGetBalance(env.arcane_db, target.id);
            expect(bal.plan).toBe('free');
            expect(bal.planMicro).toBe(0);
            expect(bal.topupMicro).toBe(123_000); // top-ups kept

            const row = await getUserRow(target.id);
            expect(row.plan).toBe('free');
            expect(row.plan_credits_micro).toBe(0);
            expect(row.plan_period_end).toBeNull();
        });

        it('a user with an ACTIVE subscriptions row and a past period end is NOT reverted', async () => {
            const token = await adminToken();
            const target = await seedPasswordUser(`grant-protected-${crypto.randomUUID()}@test.dev`, 'password123');

            const grant = await jsonPost('/v1/admin/grants', { email: target.email, tier: 'pro' }, token);
            expect(grant.status).toBe(200);

            await upsertSubscription(env.arcane_db, {
                subscriptionId: `sub_protects_${target.id}`, userId: target.id, productId: null,
                plan: 'pro', status: 'active', currentPeriodEnd: '2000-01-01T00:00:00.000Z',
            });
            await env.arcane_db.prepare("UPDATE users SET plan_period_end = '2000-01-01T00:00:00.000Z' WHERE id = ?")
                .bind(target.id).run();

            const bal = await refreshAndGetBalance(env.arcane_db, target.id);
            expect(bal.plan).toBe('pro'); // real subscriber — protected from the comp-expiry revert
            expect(bal.planMicro).toBe(tierGrantMicro('pro'));

            const row = await getUserRow(target.id);
            expect(row.plan).toBe('pro');
        });
    });
});
