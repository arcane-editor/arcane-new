import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { seedPasswordUser, tokenFor } from './helpers.ts';

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

    it('a free user is auto-granted the monthly allotment and passes the gate', async () => {
        const user = await seedPasswordUser('gate-free@test.dev', 'password123'); // free, NULL period
        const token = await tokenFor(user);

        const res = await post('/v1/embeddings', token, { input: 'hello' });
        // Gate passed (free reset granted credits); handler then fails on the
        // absent AI binding. The one thing it must NOT be is 402.
        expect(res.status).not.toBe(402);

        // The free grant was actually written.
        const r = await env.arcane_db.prepare(
            'SELECT plan_credits_micro FROM users WHERE id = ?'
        ).bind(user.id).first<{ plan_credits_micro: number }>();
        expect(r!.plan_credits_micro).toBeGreaterThan(0);
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
