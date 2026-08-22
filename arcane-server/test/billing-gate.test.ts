import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { seedPasswordUser, tokenFor } from './helpers.ts';
import { createUser } from '../src/lib/db.ts';
import { checkAiBudget } from '../src/lib/credits.ts';
import { SIGNUP_TRIAL_MICRO } from '../src/config/tiers.ts';
import { clearConfigCache, putConfigDoc } from '../src/lib/app-config.ts';
import type { ModelRoutingDoc } from '../src/lib/app-config.ts';

// Routed at a '@cf/...' id (not DEFAULT_MODEL_ROUTING's spark/... mid
// executor) for the same reason chat-metering.test.ts/tier-gate.test.ts pin
// their spark-adjacent request to CF_ONLY_ROUTING: resolveModel's 'direct'
// (spark/...) route makes a REAL fetch to the RFC-2606 spark.invalid host on
// generateText, which still errors correctly but makes Miniflare/workerd log
// a spurious "uncaught exception" line — noisy, not a correctness issue. A
// '@cf/...' id fails synchronously instead (no AI binding in the test env,
// see wrangler.test.toml), so this test stays on the credit-gate question
// only, with no fetch noise.
const CF_ONLY_ROUTING: ModelRoutingDoc = {
    tiers: {
        low: { planner: '@cf/zai-org/glm-5.2', executor: '@cf/zai-org/glm-5.2' },
        mid: { planner: '@cf/zai-org/glm-5.2', executor: '@cf/zai-org/glm-5.2' },
        high: { planner: '@cf/zai-org/glm-5.2', executor: '@cf/zai-org/glm-5.2', executorHard: 'xai/grok-4.6' },
    },
    inline: '@cf/qwen/qwen3-30b-a3b-fp8',
};

async function resetModelRouting(): Promise<void> {
    await env.arcane_db.prepare("DELETE FROM app_config WHERE key = 'model_routing'").run();
    clearConfigCache();
}

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

        await putConfigDoc(env.arcane_db, 'model_routing', CF_ONLY_ROUTING);
        try {
            const res = await post('/v1/graph/enrich', token, { stats: { nodes: 1, edges: 0, communities: 0 }, communities: [], godNodes: [] });
            expect(res.status).not.toBe(402);
            // Strengthened alongside the graph.ts model_unconfigured serve
            // guard (Finding 1): the gate passing must not be masked by a
            // *different* failure this suite would otherwise never notice —
            // a properly-catalogued '@cf/...' executor must not 503 either.
            expect(res.status).not.toBe(503);
        } finally {
            await resetModelRouting();
        }
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
