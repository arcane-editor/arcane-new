import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { seedPasswordUser, tokenFor } from './helpers.ts';
import { MODEL_CATALOG } from '../src/lib/costs.ts';
import { EXECUTOR_MODEL, DEFAULT_MODEL_ROUTING } from '../src/config/plans.ts';
import { clearConfigCache } from '../src/lib/app-config.ts';

// Finding 1 (2026-08-22 final-review fix wave): /v1/graph/enrich used to hand
// `routing.tiers.mid.executor` straight to `workersAiProvider`, which only
// knows the Workers AI binding's own catalog — the shipped default executor
// was SPARK_MODEL then (a 'direct'-route id), so every call 500'd. The fix
// serves via `resolveModel` (services/llm-router.ts) instead, and adds the
// same effective-catalog serve guard chat.ts already has. The default is a
// @cf/ id again since 2026-08-27, but an admin can still route this tier at a
// direct-route model, so both halves of the fix still earn their keep.
//
// This suite exercises the NEW guard end-to-end (no real network — the guard
// returns before ever resolving a model). The "resolveModel can actually
// serve the default mid.executor" half of the regression is covered at the
// unit level in llm-router.test.ts ("graph enrich's default model") rather
// than here, matching this codebase's existing convention (see
// chat-metering.test.ts / tier-gate.test.ts): a route-level e2e request that
// actually reaches generateText hits a real provider call, which still errors
// correctly but logs a spurious Miniflare "uncaught exception" line.

async function post(path: string, token: string, body: unknown): Promise<Response> {
    return SELF.fetch(`https://example.com${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

const ENRICH_BODY = { stats: { nodes: 1, edges: 0, communities: 0 }, communities: [], godNodes: [] };

describe('graph enrich serve guard: model_unconfigured', () => {
    it('503s (not the workersAiProvider unknown-model 500) when the resolved mid.executor is missing from the effective catalog', async () => {
        const user = await seedPasswordUser('graph-unconf@test.dev', 'password123');
        await env.arcane_db.prepare(
            "UPDATE users SET plan_credits_micro = 5000000, plan_period_end = '2099-01-01T00:00:00.000Z' WHERE id = ?"
        ).bind(user.id).run();
        const token = await tokenFor(user);

        // No model_routing row seeded → DEFAULT_MODEL_ROUTING applies, whose
        // mid.executor is EXECUTOR_MODEL (see plans.ts). Pull that entry out of
        // the live catalog so getEffectivePricing's merge no longer contains
        // it — simulating a routing doc/catalog drift, same technique as
        // chat-metering.test.ts's model_unconfigured test.
        expect(DEFAULT_MODEL_ROUTING.tiers.mid.executor).toBe(EXECUTOR_MODEL);
        const saved = MODEL_CATALOG[EXECUTOR_MODEL];
        delete MODEL_CATALOG[EXECUTOR_MODEL];
        clearConfigCache(); // force a fresh getEffectivePricing read against the mutated catalog
        try {
            const res = await post('/v1/graph/enrich', token, ENRICH_BODY);

            expect(res.status).toBe(503);
            expect(await res.json()).toEqual({
                error: 'This model is not configured. Contact support.',
                code: 'model_unconfigured',
            });

            // Nothing metered: the guard returns before generateText/recordUsage.
            const row = await env.arcane_db.prepare(
                'SELECT COUNT(*) AS n FROM request_logs WHERE user_id = ?'
            ).bind(user.id).first<{ n: number }>();
            expect(row!.n).toBe(0);
        } finally {
            MODEL_CATALOG[EXECUTOR_MODEL] = saved!;
            clearConfigCache();
        }
    });
});
