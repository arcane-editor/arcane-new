import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { seedPasswordUser, tokenFor } from './helpers.ts';
import { MODEL_CATALOG } from '../src/lib/costs.ts';
import { SPARK_MODEL } from '../src/config/plans.ts';
import { clearConfigCache } from '../src/lib/app-config.ts';

// P0 fix wave 2026-08-16: the non-streaming lane's `if (event.type ===
// 'error') throw` used to jump past logUsage entirely — a provider-error
// request produced NO request_logs row at all, invisible to the $1/hr
// anti-abuse cap. Metering now runs in a finally on both lanes.
describe('chat metering on the error lane', () => {
    it('a non-streaming request that errors still writes a request_logs row', async () => {
        const user = await seedPasswordUser('meter-err@test.dev', 'password123');
        await env.arcane_db.prepare(
            "UPDATE users SET plan = 'pro', plan_credits_micro = 5000000, plan_period_end = '2099-01-01T00:00:00.000Z' WHERE id = ?"
        ).bind(user.id).run();
        const token = await tokenFor(user);

        const res = await SELF.fetch('https://example.com/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'auto', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
        });

        // The test env has no AI binding, so the provider call fails — the
        // request 500s, but the metering row must exist regardless.
        expect(res.status).toBe(500);
        const row = await env.arcane_db.prepare(
            'SELECT COUNT(*) AS n FROM request_logs WHERE user_id = ?'
        ).bind(user.id).first<{ n: number }>();
        expect(row!.n).toBe(1);
    });
});

// The only way the model_unconfigured guard can fire in production is a
// routing target the effective pricing catalog doesn't recognize — normally
// impossible, since getModelRouting validates any stored doc against
// MODEL_CATALOG, and DEFAULT_MODEL_ROUTING (the code-default fallback used
// here — no model_routing row is seeded) is hand-written to only ever
// reference real catalog entries. Reproducing the guard therefore means
// pulling the resolved model out of the (live) MODEL_CATALOG object for the
// duration of one request — simulating a catalog/routing-doc drifting out of
// sync, restored immediately after.
describe('chat serve guard: model_unconfigured', () => {
    it('503s, streams nothing, and debits/logs nothing when the resolved model is missing from the effective catalog', async () => {
        const user = await seedPasswordUser('meter-unconf@test.dev', 'password123');
        await env.arcane_db.prepare(
            "UPDATE users SET plan_credits_micro = 5000000, plan_period_end = '2099-01-01T00:00:00.000Z' WHERE id = ?"
        ).bind(user.id).run();
        const token = await tokenFor(user);

        // Default (unset) plan is free, and free's low tier resolves to
        // SPARK_MODEL under DEFAULT_MODEL_ROUTING — pull that entry.
        const saved = MODEL_CATALOG[SPARK_MODEL];
        delete MODEL_CATALOG[SPARK_MODEL];
        clearConfigCache(); // force a fresh getEffectivePricing read against the mutated catalog
        try {
            const res = await SELF.fetch('https://example.com/v1/chat/completions', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'auto', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
            });

            expect(res.status).toBe(503);
            expect(await res.json()).toEqual({
                error: 'This model is not configured. Contact support.',
                code: 'model_unconfigured',
            });

            // Nothing streamed, nothing metered, nothing debited: the guard
            // returns before streamCompletion/logUsage ever run.
            const row = await env.arcane_db.prepare(
                'SELECT COUNT(*) AS n FROM request_logs WHERE user_id = ?'
            ).bind(user.id).first<{ n: number }>();
            expect(row!.n).toBe(0);
        } finally {
            MODEL_CATALOG[SPARK_MODEL] = saved!;
            clearConfigCache();
        }
    });
});
