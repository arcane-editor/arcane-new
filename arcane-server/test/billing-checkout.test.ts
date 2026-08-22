import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { seedPasswordUser, tokenFor, jsonPost } from './helpers.ts';
import { grantPlanCredits } from '../src/lib/db.ts';
import { tierGrantMicro, TOPUP_PACKS } from '../src/config/tiers.ts';
import type { UserRow } from '../src/lib/db.ts';

const PACK = TOPUP_PACKS[0]!.id;

async function checkout(user: UserRow, body: { tier?: string; pack?: string }): Promise<Response> {
    return jsonPost('/v1/billing/checkout', body, await tokenFor(user));
}

async function body(res: Response): Promise<{ error?: string; code?: string }> {
    return res.json();
}

describe('top-up checkout is gated on a paid plan', () => {
    it('blocks a free-plan user with 403 plan_required', async () => {
        const u = await seedPasswordUser('gate-free@test.dev', 'password123');
        const res = await checkout(u, { pack: PACK });
        expect(res.status).toBe(403);
        expect((await body(res)).code).toBe('plan_required');
    });

    it('lets a paid-plan user past the gate', async () => {
        const u = await seedPasswordUser('gate-pro@test.dev', 'password123');
        await grantPlanCredits(env.arcane_db, u.id, 'pro', tierGrantMicro('pro'), null);
        const res = await checkout(u, { pack: PACK });
        // Past the gate; DODO_API_KEY is unset in the test env, so the next
        // guard answers. 503 here is the proof the 403 did NOT fire.
        expect(res.status).toBe(503);
        expect((await body(res)).code).toBe('billing_unconfigured');
    });

    it('blocks a user whose plan reverted to free after cancellation', async () => {
        const u = await seedPasswordUser('gate-cancelled@test.dev', 'password123');
        await grantPlanCredits(env.arcane_db, u.id, 'pro', tierGrantMicro('pro'), null);
        await grantPlanCredits(env.arcane_db, u.id, 'free', tierGrantMicro('free'), null);
        const res = await checkout(u, { pack: PACK });
        expect(res.status).toBe(403);
        expect((await body(res)).code).toBe('plan_required');
    });

    it('fails closed on an unrecognised plan value', async () => {
        const u = await seedPasswordUser('gate-unknown@test.dev', 'password123');
        await env.arcane_db.prepare('UPDATE users SET plan = ? WHERE id = ?').bind('enterprise', u.id).run();
        const res = await checkout(u, { pack: PACK });
        expect(res.status).toBe(403);
        expect((await body(res)).code).toBe('plan_required');
    });

    it('reads the plan from the database, not the token', async () => {
        // Token is minted from the pre-upgrade row; the DB says pro. The gate
        // must honour the DB. (AuthPayload carries no plan claim at all — this
        // test locks in that no one adds one as a shortcut.)
        const u = await seedPasswordUser('gate-dbauth@test.dev', 'password123');
        const staleToken = await tokenFor(u);
        await grantPlanCredits(env.arcane_db, u.id, 'pro', tierGrantMicro('pro'), null);
        const res = await jsonPost('/v1/billing/checkout', { pack: PACK }, staleToken);
        expect(res.status).toBe(503);
    });
});

describe('subscription checkout stays open to free users', () => {
    it('does not block a free user upgrading to a paid tier', async () => {
        const u = await seedPasswordUser('gate-upgrade@test.dev', 'password123');
        const res = await checkout(u, { tier: 'pro' });
        // Reaches the unconfigured-billing guard, i.e. was NOT plan-gated.
        expect(res.status).toBe(503);
        expect((await body(res)).code).toBe('billing_unconfigured');
    });

    it('does not block a free user starting a starter checkout', async () => {
        const u = await seedPasswordUser('gate-starter@test.dev', 'password123');
        const res = await checkout(u, { tier: 'starter' });
        expect(res.status).toBe(503);
        expect((await body(res)).code).toBe('billing_unconfigured');
    });

    it('still rejects a bogus tier with 400', async () => {
        const u = await seedPasswordUser('gate-badtier@test.dev', 'password123');
        const res = await checkout(u, { tier: 'platinum' });
        expect(res.status).toBe(400);
    });

    it('still rejects a bogus pack with 400 before any plan check', async () => {
        const u = await seedPasswordUser('gate-badpack@test.dev', 'password123');
        const res = await checkout(u, { pack: 'topup_9999' });
        expect(res.status).toBe(400);
    });
});
