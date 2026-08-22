import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { seedPasswordUser, tokenFor } from './helpers.ts';
import { createUser } from '../src/lib/db.ts';
import { checkAiBudget } from '../src/lib/credits.ts';
import { SIGNUP_TRIAL_MICRO } from '../src/config/tiers.ts';

// End-to-end enforcement: the credit gate runs inside each AI route, BEFORE any
// model call, so an out-of-credits user is rejected with 402 even though the
// test env has no AI binding. A user with credits passes the gate (and only
// then hits the absent binding).

async function post(path: string, token: string, body: unknown): Promise<Response> {
    return SELF.fetch(`https://example.com${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

describe('credit gate on AI routes', () => {
    it('402 credits_exhausted for a paid user with a zero balance', async () => {
        const user = await seedPasswordUser('gate-empty@test.dev', 'password123'); // verified
        await env.arcane_db.prepare(
            "UPDATE users SET plan = 'pro', plan_credits_micro = 0, topup_credits_micro = 0, plan_period_end = '2099-01-01T00:00:00.000Z' WHERE id = ?"
        ).bind(user.id).run();
        const token = await tokenFor(user);

        const res = await post('/v1/embeddings', token, { input: 'hello' });
        expect(res.status).toBe(402);
        expect(await res.json()).toEqual({ error: expect.any(String), code: 'credits_exhausted' });
    });

    it('a paid user with credits passes the gate (no 402)', async () => {
        const user = await seedPasswordUser('gate-paid@test.dev', 'password123');
        await env.arcane_db.prepare(
            "UPDATE users SET plan = 'pro', plan_credits_micro = 5000000, plan_period_end = '2099-01-01T00:00:00.000Z' WHERE id = ?"
        ).bind(user.id).run();
        const token = await tokenFor(user);

        const res = await post('/v1/graph/enrich', token, { stats: { nodes: 1, edges: 0, communities: 0 }, communities: [], godNodes: [] });
        expect(res.status).not.toBe(402);
    });
});

// The free plan's 150 credits are a ONE-TIME signup trial now (not a monthly
// grant that refreshAndGetBalance used to hand out lazily) — granted only at
// the moment of signup, by createUser/createOAuthUser (see lib/db.ts).
describe('the signup trial — one-time, not a recurring grant', () => {
    it('a user created via createUser carries the signup trial and passes checkAiBudget', async () => {
        const user = await createUser(env.arcane_db, {
            email: 'signup-trial@test.dev', passwordHash: 'x', salt: 'y', emailVerified: true,
        });
        expect(user.plan_credits_micro).toBe(SIGNUP_TRIAL_MICRO);
        expect(user.plan_period_end).toBeNull(); // free never anchors a cycle

        const res = await checkAiBudget(env.arcane_db, user.id);
        expect(res.ok).toBe(true);
    });

    it('an exhausted free user 402s and is NOT regranted', async () => {
        const user = await createUser(env.arcane_db, {
            email: 'signup-exhausted@test.dev', passwordHash: 'x', salt: 'y', emailVerified: true,
        });
        await env.arcane_db.prepare('UPDATE users SET plan_credits_micro = 0 WHERE id = ?').bind(user.id).run();

        const res = await checkAiBudget(env.arcane_db, user.id);
        expect(res.ok).toBe(false);
        if (!res.ok) { expect(res.status).toBe(402); expect(res.code).toBe('credits_exhausted'); }

        const r = await env.arcane_db.prepare('SELECT plan_credits_micro FROM users WHERE id = ?')
            .bind(user.id).first<{ plan_credits_micro: number }>();
        expect(r!.plan_credits_micro).toBe(0); // still zero — no lazy regrant
    });
});
