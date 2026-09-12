import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
    getModelRouting, getEffectivePricing, getHarnessLimits, putConfigDoc, readConfigDoc, clearConfigCache,
    validateModelRoutingDoc, validateModelPricingDoc, validateHarnessLimitsDoc,
} from '../src/lib/app-config.ts';
import type { ModelRoutingDoc, ModelPricingDoc, EffectivePricing } from '../src/lib/app-config.ts';
import { MODEL_CATALOG, estimateCost, type ModelInfo } from '../src/lib/costs.ts';
import { billedMicro } from '../src/lib/usage.ts';
import { usdToMicro } from '../src/config/tiers.ts';
import { DEFAULT_MODEL_ROUTING, DEFAULT_HARNESS_LIMITS } from '../src/config/plans.ts';
import type { HarnessLimitsDoc } from '../src/config/plans.ts';
import { resolveModelForSend } from '../src/config/routing.ts';

// A valid routing doc built entirely from real catalog entries — reused as
// the "known-good" fixture across the cache/put/read tests below.
const VALID_ROUTING_DOC: ModelRoutingDoc = {
    tiers: {
        low:  { planner: '@cf/zai-org/glm-5.2', executor: '@cf/zai-org/glm-5.2' },
        mid:  { planner: 'xai/grok-4.6', executor: '@cf/zai-org/glm-5.2' },
        high: { planner: 'openai/gpt-5.6-luna', executor: '@cf/zai-org/glm-5.2', executorHard: 'xai/grok-4.6' },
    },
    inline: '@cf/qwen/qwen3-30b-a3b-fp8',
};

const VALID_PRICING_DOC: ModelPricingDoc = {
    models: {
        '@cf/zai-org/glm-5.2': { ...MODEL_CATALOG['@cf/zai-org/glm-5.2']! },
    },
    gatewayFee: 1.05,
    margin: 1.0,
};

const VALID_HARNESS_LIMITS_DOC: HarnessLimitsDoc = {
    tiers: { low: { maxModelCalls: 500 }, mid: { maxModelCalls: 900 }, high: { maxModelCalls: 1200 } },
};

// Every test starts from a cold per-isolate cache so no test observes a
// value another test populated (app_config keys are singletons: 'model_
// routing' | 'model_pricing').
beforeEach(() => clearConfigCache());
afterEach(() => clearConfigCache());

describe('getModelRouting', () => {
    it('returns DEFAULT_MODEL_ROUTING when the table has no model_routing row, SILENTLY (no error log)', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const routing = await getModelRouting(env.arcane_db);
        expect(routing).toEqual(DEFAULT_MODEL_ROUTING);
        // A missing row is the normal, defaults-active state of a fresh deploy —
        // NOT an anomaly — so it must not log.
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it('does not throw on an empty table', async () => {
        await expect(getModelRouting(env.arcane_db)).resolves.toBeDefined();
    });

    it('serves a stored doc after putConfigDoc, distinguishable via readConfigDoc', async () => {
        expect(await readConfigDoc(env.arcane_db, 'model_routing')).toBeNull();

        await putConfigDoc(env.arcane_db, 'model_routing', VALID_ROUTING_DOC);

        const routing = await getModelRouting(env.arcane_db);
        expect(routing).toEqual(VALID_ROUTING_DOC);

        const raw = await readConfigDoc(env.arcane_db, 'model_routing');
        expect(raw).not.toBeNull();
        expect(JSON.parse(raw!.raw)).toEqual(VALID_ROUTING_DOC);
        expect(typeof raw!.updatedAt).toBe('string');
    });

    it('serves the cached value after a direct SQL update bypassing putConfigDoc, until clearConfigCache', async () => {
        await putConfigDoc(env.arcane_db, 'model_routing', VALID_ROUTING_DOC);
        const first = await getModelRouting(env.arcane_db); // populates cache
        expect(first.inline).toBe('@cf/qwen/qwen3-30b-a3b-fp8');

        const updatedDoc: ModelRoutingDoc = { ...VALID_ROUTING_DOC, inline: '@cf/qwen/qwen3-30b-a3b-fp8' };
        // Bump a harmless field so the row differs without breaking validation,
        // via a raw UPDATE that does NOT go through putConfigDoc (no cache bust).
        const bumped: ModelRoutingDoc = {
            tiers: { ...updatedDoc.tiers, low: { planner: 'xai/grok-4.6', executor: 'xai/grok-4.6' } },
            inline: '@cf/qwen/qwen3-30b-a3b-fp8',
        };
        await env.arcane_db.prepare("UPDATE app_config SET value = ?1 WHERE key = 'model_routing'")
            .bind(JSON.stringify(bumped)).run();

        const stillCached = await getModelRouting(env.arcane_db);
        expect(stillCached).toEqual(first); // cache not invalidated by the raw UPDATE

        clearConfigCache();
        const fresh = await getModelRouting(env.arcane_db);
        expect(fresh).toEqual(bumped);
    });

    it('putConfigDoc invalidates this isolate\'s cache immediately', async () => {
        await putConfigDoc(env.arcane_db, 'model_routing', VALID_ROUTING_DOC);
        const first = await getModelRouting(env.arcane_db);
        expect(first).toEqual(VALID_ROUTING_DOC);

        const second: ModelRoutingDoc = { ...VALID_ROUTING_DOC, inline: '@cf/qwen/qwen3-30b-a3b-fp8' };
        await putConfigDoc(env.arcane_db, 'model_routing', second);

        const after = await getModelRouting(env.arcane_db);
        expect(after).toEqual(second); // no clearConfigCache() call needed
    });

    it('falls back to defaults and logs a structured error on malformed JSON', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await env.arcane_db.prepare(
            "INSERT INTO app_config (key, value, updated_at) VALUES ('model_routing', '{not json', datetime('now')) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).run();

        const routing = await getModelRouting(env.arcane_db);
        expect(routing).toEqual(DEFAULT_MODEL_ROUTING);

        expect(spy).toHaveBeenCalledTimes(1);
        const logged = JSON.parse(spy.mock.calls[0]![0] as string);
        expect(logged.event).toBe('app_config_invalid');
        expect(logged.key).toBe('model_routing');
        spy.mockRestore();
    });

    it('falls back to defaults and logs on an invalid doc (missing tier, non-@cf inline, unknown model)', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const badDoc = {
            tiers: {
                low: { planner: '@cf/zai-org/glm-5.2', executor: '@cf/zai-org/glm-5.2' },
                mid: { planner: 'xai/grok-4.6', executor: '@cf/zai-org/glm-5.2' },
                // high tier missing entirely
            },
            inline: 'openai/not-a-cf-model', // not @cf/, also unknown
        };
        await putConfigDoc(env.arcane_db, 'model_routing', badDoc);

        const routing = await getModelRouting(env.arcane_db);
        expect(routing).toEqual(DEFAULT_MODEL_ROUTING);
        expect(spy).toHaveBeenCalledTimes(1);
        const logged = JSON.parse(spy.mock.calls[0]![0] as string);
        expect(logged.event).toBe('app_config_invalid');
        expect(logged.key).toBe('model_routing');
        spy.mockRestore();
    });
});

describe('getEffectivePricing', () => {
    it('returns {MODEL_CATALOG, GATEWAY_FEE, MARGIN} when the table has no model_pricing row, SILENTLY (no error log)', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const pricing = await getEffectivePricing(env.arcane_db);
        expect(pricing.catalog).toBe(MODEL_CATALOG);
        expect(pricing.gatewayFee).toBe(1.05);
        expect(pricing.margin).toBe(1.0);
        // A missing row is the normal, defaults-active state of a fresh deploy —
        // NOT an anomaly — so it must not log.
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it('does not throw on an empty table', async () => {
        await expect(getEffectivePricing(env.arcane_db)).resolves.toBeDefined();
    });

    it('serves a stored doc merged over MODEL_CATALOG after putConfigDoc', async () => {
        expect(await readConfigDoc(env.arcane_db, 'model_pricing')).toBeNull();

        await putConfigDoc(env.arcane_db, 'model_pricing', VALID_PRICING_DOC);

        const pricing = await getEffectivePricing(env.arcane_db);
        expect(pricing.catalog['@cf/zai-org/glm-5.2']).toEqual(VALID_PRICING_DOC.models['@cf/zai-org/glm-5.2']);
        // Untouched slugs still come through from MODEL_CATALOG.
        expect(pricing.catalog['xai/grok-4.6']).toEqual(MODEL_CATALOG['xai/grok-4.6']);
        expect(pricing.gatewayFee).toBe(1.05);
        expect(pricing.margin).toBe(1.0);

        const raw = await readConfigDoc(env.arcane_db, 'model_pricing');
        expect(raw).not.toBeNull();
    });

    it('serves the cached value after a direct SQL update, until clearConfigCache', async () => {
        await putConfigDoc(env.arcane_db, 'model_pricing', VALID_PRICING_DOC);
        const first = await getEffectivePricing(env.arcane_db);
        expect(first.gatewayFee).toBe(1.05);

        const bumped: ModelPricingDoc = { ...VALID_PRICING_DOC, gatewayFee: 1.10 };
        await env.arcane_db.prepare("UPDATE app_config SET value = ?1 WHERE key = 'model_pricing'")
            .bind(JSON.stringify(bumped)).run();

        const stillCached = await getEffectivePricing(env.arcane_db);
        expect(stillCached.gatewayFee).toBe(1.05); // cache not invalidated by the raw UPDATE

        clearConfigCache();
        const fresh = await getEffectivePricing(env.arcane_db);
        expect(fresh.gatewayFee).toBe(1.10);
    });

    it('putConfigDoc invalidates this isolate\'s cache immediately', async () => {
        await putConfigDoc(env.arcane_db, 'model_pricing', VALID_PRICING_DOC);
        const first = await getEffectivePricing(env.arcane_db);
        expect(first.margin).toBe(1.0);

        await putConfigDoc(env.arcane_db, 'model_pricing', { ...VALID_PRICING_DOC, margin: 1.2 });
        const after = await getEffectivePricing(env.arcane_db);
        expect(after.margin).toBe(1.2);
    });

    it('falls back to defaults and logs a structured error on malformed JSON', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await env.arcane_db.prepare(
            "INSERT INTO app_config (key, value, updated_at) VALUES ('model_pricing', 'not json at all', datetime('now')) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).run();

        const pricing = await getEffectivePricing(env.arcane_db);
        expect(pricing.catalog).toBe(MODEL_CATALOG);
        expect(spy).toHaveBeenCalledTimes(1);
        const logged = JSON.parse(spy.mock.calls[0]![0] as string);
        expect(logged.event).toBe('app_config_invalid');
        expect(logged.key).toBe('model_pricing');
        spy.mockRestore();
    });

    it('falls back to defaults and logs on an invalid doc (gatewayFee < 1)', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await putConfigDoc(env.arcane_db, 'model_pricing', { ...VALID_PRICING_DOC, gatewayFee: 0.5 });

        const pricing = await getEffectivePricing(env.arcane_db);
        expect(pricing.gatewayFee).toBe(1.05); // code default, not the invalid 0.5
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockRestore();
    });
});

describe('getHarnessLimits', () => {
    it('returns DEFAULT_HARNESS_LIMITS when the table has no harness_limits row, SILENTLY (no error log)', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const limits = await getHarnessLimits(env.arcane_db);
        expect(limits).toEqual(DEFAULT_HARNESS_LIMITS);
        expect(limits.tiers).toEqual({ low: { maxModelCalls: 1000 }, mid: { maxModelCalls: 1600 }, high: { maxModelCalls: 2000 } });
        // A missing row is the normal, defaults-active state of a fresh deploy —
        // NOT an anomaly — so it must not log.
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it('does not throw on an empty table', async () => {
        await expect(getHarnessLimits(env.arcane_db)).resolves.toBeDefined();
    });

    it('serves a stored doc after putConfigDoc, distinguishable via readConfigDoc', async () => {
        expect(await readConfigDoc(env.arcane_db, 'harness_limits')).toBeNull();

        await putConfigDoc(env.arcane_db, 'harness_limits', VALID_HARNESS_LIMITS_DOC);

        const limits = await getHarnessLimits(env.arcane_db);
        expect(limits).toEqual(VALID_HARNESS_LIMITS_DOC);

        const raw = await readConfigDoc(env.arcane_db, 'harness_limits');
        expect(raw).not.toBeNull();
        expect(JSON.parse(raw!.raw)).toEqual(VALID_HARNESS_LIMITS_DOC);
        expect(typeof raw!.updatedAt).toBe('string');
    });

    it('serves the cached value after a direct SQL update bypassing putConfigDoc, until clearConfigCache', async () => {
        await putConfigDoc(env.arcane_db, 'harness_limits', VALID_HARNESS_LIMITS_DOC);
        const first = await getHarnessLimits(env.arcane_db); // populates cache
        expect(first.tiers.low.maxModelCalls).toBe(500);

        const bumped: HarnessLimitsDoc = { tiers: { ...VALID_HARNESS_LIMITS_DOC.tiers, low: { maxModelCalls: 750 } } };
        await env.arcane_db.prepare("UPDATE app_config SET value = ?1 WHERE key = 'harness_limits'")
            .bind(JSON.stringify(bumped)).run();

        const stillCached = await getHarnessLimits(env.arcane_db);
        expect(stillCached).toEqual(first); // cache not invalidated by the raw UPDATE

        clearConfigCache();
        const fresh = await getHarnessLimits(env.arcane_db);
        expect(fresh).toEqual(bumped);
    });

    it('putConfigDoc invalidates this isolate\'s cache immediately', async () => {
        await putConfigDoc(env.arcane_db, 'harness_limits', VALID_HARNESS_LIMITS_DOC);
        const first = await getHarnessLimits(env.arcane_db);
        expect(first).toEqual(VALID_HARNESS_LIMITS_DOC);

        const second: HarnessLimitsDoc = { tiers: { ...VALID_HARNESS_LIMITS_DOC.tiers, high: { maxModelCalls: 1500 } } };
        await putConfigDoc(env.arcane_db, 'harness_limits', second);

        const after = await getHarnessLimits(env.arcane_db);
        expect(after).toEqual(second); // no clearConfigCache() call needed
    });

    it('falls back to defaults and logs a structured error on malformed JSON', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await env.arcane_db.prepare(
            "INSERT INTO app_config (key, value, updated_at) VALUES ('harness_limits', 'not json at all', datetime('now')) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).run();

        const limits = await getHarnessLimits(env.arcane_db);
        expect(limits).toEqual(DEFAULT_HARNESS_LIMITS);

        expect(spy).toHaveBeenCalledTimes(1);
        const logged = JSON.parse(spy.mock.calls[0]![0] as string);
        expect(logged.event).toBe('app_config_invalid');
        expect(logged.key).toBe('harness_limits');
        spy.mockRestore();
    });

    it('falls back to defaults and logs on an invalid doc (missing tier)', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const badDoc = {
            tiers: {
                low: { maxModelCalls: 500 },
                mid: { maxModelCalls: 900 },
                // high tier missing entirely
            },
        };
        await putConfigDoc(env.arcane_db, 'harness_limits', badDoc);

        const limits = await getHarnessLimits(env.arcane_db);
        expect(limits).toEqual(DEFAULT_HARNESS_LIMITS);
        expect(spy).toHaveBeenCalledTimes(1);
        const logged = JSON.parse(spy.mock.calls[0]![0] as string);
        expect(logged.event).toBe('app_config_invalid');
        expect(logged.key).toBe('harness_limits');
        spy.mockRestore();
    });
});

describe('putConfigDoc invalidates the harness_limits cache too', () => {
    it('a model_routing write also invalidates the cached harness_limits value', async () => {
        await putConfigDoc(env.arcane_db, 'harness_limits', VALID_HARNESS_LIMITS_DOC);
        const first = await getHarnessLimits(env.arcane_db); // populates the harness_limits cache
        expect(first).toEqual(VALID_HARNESS_LIMITS_DOC);

        // An unrelated routing write should still bust the harness_limits
        // cache, per putConfigDoc's uniform (branch-free) invalidation.
        await putConfigDoc(env.arcane_db, 'model_routing', VALID_ROUTING_DOC);

        // Prove the cache was actually invalidated (not coincidentally still
        // correct): mutate the harness_limits row directly via raw SQL,
        // bypassing putConfigDoc entirely (which would invalidate it anyway).
        const bumped: HarnessLimitsDoc = { tiers: { ...VALID_HARNESS_LIMITS_DOC.tiers, mid: { maxModelCalls: 111 } } };
        await env.arcane_db.prepare("UPDATE app_config SET value = ?1 WHERE key = 'harness_limits'")
            .bind(JSON.stringify(bumped)).run();

        const afterRoutingWrite = await getHarnessLimits(env.arcane_db);
        // If the routing write had NOT invalidated the harness_limits cache,
        // this would still equal `first` (the stale cached VALID_HARNESS_LIMITS_DOC).
        expect(afterRoutingWrite).toEqual(bumped);
    });
});

describe('validateHarnessLimitsDoc', () => {
    it('accepts a fully valid doc', () => {
        expect(validateHarnessLimitsDoc(VALID_HARNESS_LIMITS_DOC)).toBeNull();
    });

    it('accepts DEFAULT_HARNESS_LIMITS', () => {
        expect(validateHarnessLimitsDoc(DEFAULT_HARNESS_LIMITS)).toBeNull();
    });

    it.each([null, undefined, 'string', 42, []])('rejects a non-object doc: %p', (x) => {
        expect(validateHarnessLimitsDoc(x)).not.toBeNull();
    });

    it('rejects a doc missing the tiers object', () => {
        expect(validateHarnessLimitsDoc({})).not.toBeNull();
    });

    it.each(['low', 'mid', 'high'] as const)('rejects a doc missing the %s tier', (missing) => {
        const tiers: Record<string, unknown> = {
            low: { maxModelCalls: 500 },
            mid: { maxModelCalls: 900 },
            high: { maxModelCalls: 1200 },
        };
        delete tiers[missing];
        expect(validateHarnessLimitsDoc({ tiers })).not.toBeNull();
    });

    it.each([1.5, '1000', null, undefined, NaN, Infinity])('rejects a non-integer maxModelCalls: %p', (v) => {
        const doc = { tiers: { ...VALID_HARNESS_LIMITS_DOC.tiers, low: { maxModelCalls: v } } };
        expect(validateHarnessLimitsDoc(doc)).not.toBeNull();
    });

    it('rejects maxModelCalls == 0', () => {
        const doc = { tiers: { ...VALID_HARNESS_LIMITS_DOC.tiers, low: { maxModelCalls: 0 } } };
        expect(validateHarnessLimitsDoc(doc)).not.toBeNull();
    });

    it('rejects maxModelCalls == 100_001', () => {
        const doc = { tiers: { ...VALID_HARNESS_LIMITS_DOC.tiers, high: { maxModelCalls: 100_001 } } };
        expect(validateHarnessLimitsDoc(doc)).not.toBeNull();
    });

    it('accepts maxModelCalls == 1 (lower bound)', () => {
        const doc = { tiers: { ...VALID_HARNESS_LIMITS_DOC.tiers, low: { maxModelCalls: 1 } } };
        expect(validateHarnessLimitsDoc(doc)).toBeNull();
    });

    it('accepts maxModelCalls == 100_000 (upper bound)', () => {
        const doc = { tiers: { ...VALID_HARNESS_LIMITS_DOC.tiers, high: { maxModelCalls: 100_000 } } };
        expect(validateHarnessLimitsDoc(doc)).toBeNull();
    });

    it('rejects a negative maxModelCalls', () => {
        const doc = { tiers: { ...VALID_HARNESS_LIMITS_DOC.tiers, mid: { maxModelCalls: -1 } } };
        expect(validateHarnessLimitsDoc(doc)).not.toBeNull();
    });
});

describe('merged pricing math (integration)', () => {
    it('an admin outputCostPer1M override reflects in estimateCost via the merged catalog, not the static call', async () => {
        await putConfigDoc(env.arcane_db, 'model_pricing', {
            models: { '@cf/zai-org/glm-5.2': { ...MODEL_CATALOG['@cf/zai-org/glm-5.2']!, outputCostPer1M: 999.0 } },
            gatewayFee: 1.05,
            margin: 1.0,
        });

        const pricing = await getEffectivePricing(env.arcane_db);
        const merged = estimateCost('@cf/zai-org/glm-5.2', 0, 1_000, 0, pricing.catalog);
        const staticCost = estimateCost('@cf/zai-org/glm-5.2', 0, 1_000, 0); // no catalog arg -> static MODEL_CATALOG

        expect(merged).toBeCloseTo((1_000 * 999.0) / 1e6, 10);
        expect(staticCost).toBeCloseTo((1_000 * 4.40) / 1e6, 10);
        expect(merged).toBeGreaterThan(staticCost);
    });

    it('billedMicro doubles the debit when margin is 2', () => {
        const base: EffectivePricing = { catalog: MODEL_CATALOG, gatewayFee: 1, margin: 1 };
        const doubled: EffectivePricing = { catalog: MODEL_CATALOG, gatewayFee: 1, margin: 2 };
        const b1 = billedMicro('@cf/zai-org/glm-5.2', 10_000, 1_000, 0, base);
        const b2 = billedMicro('@cf/zai-org/glm-5.2', 10_000, 1_000, 0, doubled);
        expect(b2).toBe(b1 * 2);
    });

    it('waives the gateway fee for a route:direct model but applies it for a workers-ai model', () => {
        const pricing: EffectivePricing = { catalog: MODEL_CATALOG, gatewayFee: 2, margin: 1 };
        const directModel = 'spark/muse-spark-1.2-contributor'; // route: 'direct'
        const workersModel = '@cf/zai-org/glm-4.7-flash';        // route: 'workers-ai'

        const directMicro = billedMicro(directModel, 1_000_000, 0, 0, pricing);
        const workersMicro = billedMicro(workersModel, 1_000_000, 0, 0, pricing);

        expect(directMicro).toBe(usdToMicro(estimateCost(directModel, 1_000_000, 0, 0) * 1 /* fee waived */));
        expect(workersMicro).toBe(usdToMicro(estimateCost(workersModel, 1_000_000, 0, 0) * 2 /* fee applied */));
    });
});

// A custom model that exists ONLY via a model_pricing override — never in
// static MODEL_CATALOG. This is the exact admin workflow this task's
// getModelRouting fix protects: an owner adds a brand-new model's rates via
// PUT /admin/config/pricing, then points a tier at it via PUT
// /admin/config/models — both writes go through putConfigDoc directly here
// (the HTTP routes are covered end-to-end in test/admin-config.test.ts).
const CUSTOM_MODEL_ID = 'test/custom-model-x';
const CUSTOM_MODEL_INFO: ModelInfo = { ...MODEL_CATALOG['@cf/zai-org/glm-5.2']! };

describe('getModelRouting validates against the EFFECTIVE (pricing-merged) catalog', () => {
    it('a routing doc referencing a model that exists only via a pricing override round-trips (NOT DEFAULT_MODEL_ROUTING), and both resolveModelForSend + the serve guard resolve it', async () => {
        await putConfigDoc(env.arcane_db, 'model_pricing', {
            models: { [CUSTOM_MODEL_ID]: CUSTOM_MODEL_INFO }, gatewayFee: 1.05, margin: 1.0,
        });

        const routingDoc: ModelRoutingDoc = {
            tiers: {
                low:  { planner: '@cf/zai-org/glm-5.2', executor: '@cf/zai-org/glm-5.2' },
                mid:  { planner: 'xai/grok-4.6', executor: CUSTOM_MODEL_ID },
                high: { planner: 'openai/gpt-5.6-luna', executor: '@cf/zai-org/glm-5.2', executorHard: 'xai/grok-4.6' },
            },
            inline: '@cf/qwen/qwen3-30b-a3b-fp8',
        };
        await putConfigDoc(env.arcane_db, 'model_routing', routingDoc);
        clearConfigCache();

        // Before the fix, getModelRouting validated against static
        // MODEL_CATALOG only: CUSTOM_MODEL_ID would fail that check, fall
        // back to DEFAULT_MODEL_ROUTING, and log a spurious anomaly.
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const routing = await getModelRouting(env.arcane_db);
        expect(routing).toEqual(routingDoc);
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();

        // Runtime promise end-to-end (unit level, mirroring chat.ts's actual
        // call sequence): resolveModelForSend picks the custom model for the
        // mid tier's executor slot...
        const decision = resolveModelForSend('mid', {}, routing);
        expect(decision.model).toBe(CUSTOM_MODEL_ID);
        expect(decision.reason).toBe('executor');

        // ...and chat.ts's serve guard (pricing.catalog[decision.model]) finds
        // it, so the request would actually be served rather than 503
        // model_unconfigured.
        const pricing = await getEffectivePricing(env.arcane_db);
        expect(pricing.catalog[decision.model]).toBeDefined();
    });
});

describe('putConfigDoc cross-invalidates both cache keys', () => {
    it('a model_pricing write also invalidates the cached model_routing value', async () => {
        await putConfigDoc(env.arcane_db, 'model_routing', VALID_ROUTING_DOC);
        const first = await getModelRouting(env.arcane_db); // populates the model_routing cache
        expect(first).toEqual(VALID_ROUTING_DOC);

        // An unrelated pricing write should still bust the routing cache —
        // getModelRouting's cached validity now depends on the effective
        // (pricing-merged) catalog, so a pricing change can flip it.
        await putConfigDoc(env.arcane_db, 'model_pricing', VALID_PRICING_DOC);

        // Prove the routing cache was actually invalidated (not coincidentally
        // still correct): mutate the model_routing row directly via raw SQL,
        // bypassing putConfigDoc entirely (which would invalidate it anyway).
        const bumped: ModelRoutingDoc = {
            tiers: { ...VALID_ROUTING_DOC.tiers, low: { planner: 'xai/grok-4.6', executor: 'xai/grok-4.6' } },
            inline: '@cf/qwen/qwen3-30b-a3b-fp8',
        };
        await env.arcane_db.prepare("UPDATE app_config SET value = ?1 WHERE key = 'model_routing'")
            .bind(JSON.stringify(bumped)).run();

        const afterPricingWrite = await getModelRouting(env.arcane_db);
        // If the pricing write had NOT invalidated the routing cache, this
        // would still equal `first` (the stale cached VALID_ROUTING_DOC).
        expect(afterPricingWrite).toEqual(bumped);
    });

    it('a model_routing write also invalidates the cached model_pricing value', async () => {
        await putConfigDoc(env.arcane_db, 'model_pricing', VALID_PRICING_DOC);
        const first = await getEffectivePricing(env.arcane_db);
        expect(first.gatewayFee).toBe(1.05);

        await putConfigDoc(env.arcane_db, 'model_routing', VALID_ROUTING_DOC);

        const bumped: ModelPricingDoc = { ...VALID_PRICING_DOC, gatewayFee: 1.2 };
        await env.arcane_db.prepare("UPDATE app_config SET value = ?1 WHERE key = 'model_pricing'")
            .bind(JSON.stringify(bumped)).run();

        const afterRoutingWrite = await getEffectivePricing(env.arcane_db);
        expect(afterRoutingWrite.gatewayFee).toBe(1.2);
    });
});

describe('validateModelRoutingDoc', () => {
    const catalog = MODEL_CATALOG;

    it('accepts a fully valid doc', () => {
        expect(validateModelRoutingDoc(VALID_ROUTING_DOC, catalog)).toBeNull();
    });

    it('accepts a valid doc without executorHard', () => {
        const doc: ModelRoutingDoc = {
            tiers: {
                low: { planner: '@cf/zai-org/glm-5.2', executor: '@cf/zai-org/glm-5.2' },
                mid: { planner: '@cf/zai-org/glm-5.2', executor: '@cf/zai-org/glm-5.2' },
                high: { planner: '@cf/zai-org/glm-5.2', executor: '@cf/zai-org/glm-5.2' },
            },
            inline: '@cf/qwen/qwen3-30b-a3b-fp8',
        };
        expect(validateModelRoutingDoc(doc, catalog)).toBeNull();
    });

    it.each([null, undefined, 'string', 42, []])('rejects a non-object doc: %p', (x) => {
        expect(validateModelRoutingDoc(x, catalog)).not.toBeNull();
    });

    it('rejects a doc missing the tiers object', () => {
        expect(validateModelRoutingDoc({ inline: '@cf/qwen/qwen3-30b-a3b-fp8' }, catalog)).not.toBeNull();
    });

    it.each(['low', 'mid', 'high'] as const)('rejects a doc missing the %s tier', (missing) => {
        const tiers: Record<string, unknown> = {
            low: { planner: '@cf/zai-org/glm-5.2', executor: '@cf/zai-org/glm-5.2' },
            mid: { planner: '@cf/zai-org/glm-5.2', executor: '@cf/zai-org/glm-5.2' },
            high: { planner: '@cf/zai-org/glm-5.2', executor: '@cf/zai-org/glm-5.2' },
        };
        delete tiers[missing];
        expect(validateModelRoutingDoc({ tiers, inline: '@cf/qwen/qwen3-30b-a3b-fp8' }, catalog)).not.toBeNull();
    });

    it('rejects a tier with an empty planner', () => {
        const doc = {
            tiers: {
                low: { planner: '', executor: '@cf/zai-org/glm-5.2' },
                mid: { planner: '@cf/zai-org/glm-5.2', executor: '@cf/zai-org/glm-5.2' },
                high: { planner: '@cf/zai-org/glm-5.2', executor: '@cf/zai-org/glm-5.2' },
            },
            inline: '@cf/qwen/qwen3-30b-a3b-fp8',
        };
        expect(validateModelRoutingDoc(doc, catalog)).not.toBeNull();
    });

    it('rejects a tier with a missing executor', () => {
        const doc = {
            tiers: {
                low: { planner: '@cf/zai-org/glm-5.2' },
                mid: { planner: '@cf/zai-org/glm-5.2', executor: '@cf/zai-org/glm-5.2' },
                high: { planner: '@cf/zai-org/glm-5.2', executor: '@cf/zai-org/glm-5.2' },
            },
            inline: '@cf/qwen/qwen3-30b-a3b-fp8',
        };
        expect(validateModelRoutingDoc(doc, catalog)).not.toBeNull();
    });

    it('rejects a planner/executor referencing a model not in the catalog', () => {
        const doc = {
            tiers: {
                low: { planner: 'nope/unknown-model', executor: '@cf/zai-org/glm-5.2' },
                mid: { planner: '@cf/zai-org/glm-5.2', executor: '@cf/zai-org/glm-5.2' },
                high: { planner: '@cf/zai-org/glm-5.2', executor: '@cf/zai-org/glm-5.2' },
            },
            inline: '@cf/qwen/qwen3-30b-a3b-fp8',
        };
        expect(validateModelRoutingDoc(doc, catalog)).not.toBeNull();
    });

    it('accepts a valid executorHard and rejects an unknown one', () => {
        const good = {
            ...VALID_ROUTING_DOC,
            tiers: { ...VALID_ROUTING_DOC.tiers, high: { ...VALID_ROUTING_DOC.tiers.high, executorHard: 'xai/grok-4.6' } },
        };
        expect(validateModelRoutingDoc(good, catalog)).toBeNull();

        const bad = {
            ...VALID_ROUTING_DOC,
            tiers: { ...VALID_ROUTING_DOC.tiers, high: { ...VALID_ROUTING_DOC.tiers.high, executorHard: 'nope/unknown' } },
        };
        expect(validateModelRoutingDoc(bad, catalog)).not.toBeNull();
    });

    it('rejects inline that is empty', () => {
        expect(validateModelRoutingDoc({ ...VALID_ROUTING_DOC, inline: '' }, catalog)).not.toBeNull();
    });

    it('rejects inline that does not start with @cf/', () => {
        expect(validateModelRoutingDoc({ ...VALID_ROUTING_DOC, inline: 'xai/grok-4.6' }, catalog)).not.toBeNull();
    });

    it('rejects inline referencing a model not in the catalog', () => {
        expect(validateModelRoutingDoc({ ...VALID_ROUTING_DOC, inline: '@cf/nope/unknown' }, catalog)).not.toBeNull();
    });
});

describe('validateModelPricingDoc', () => {
    it('accepts a fully valid doc', () => {
        expect(validateModelPricingDoc(VALID_PRICING_DOC)).toBeNull();
    });

    it.each([null, undefined, 'string', 42, []])('rejects a non-object doc: %p', (x) => {
        expect(validateModelPricingDoc(x)).not.toBeNull();
    });

    it('rejects a doc where models is not an object', () => {
        expect(validateModelPricingDoc({ models: 'nope', gatewayFee: 1.05, margin: 1 })).not.toBeNull();
    });

    it.each(['inputCostPer1M', 'outputCostPer1M', 'cachedInputCostPer1M'] as const)(
        'rejects a negative %s', (field) => {
            const model = { ...MODEL_CATALOG['@cf/zai-org/glm-5.2']!, [field]: -1 };
            expect(validateModelPricingDoc({ models: { m: model }, gatewayFee: 1.05, margin: 1 })).not.toBeNull();
        },
    );

    it.each(['inputCostPer1M', 'outputCostPer1M', 'cachedInputCostPer1M'] as const)(
        'rejects a non-finite %s (NaN/Infinity)', (field) => {
            const model = { ...MODEL_CATALOG['@cf/zai-org/glm-5.2']!, [field]: Infinity };
            expect(validateModelPricingDoc({ models: { m: model }, gatewayFee: 1.05, margin: 1 })).not.toBeNull();
        },
    );

    it('rejects contextWindow <= 0', () => {
        const model = { ...MODEL_CATALOG['@cf/zai-org/glm-5.2']!, contextWindow: 0 };
        expect(validateModelPricingDoc({ models: { m: model }, gatewayFee: 1.05, margin: 1 })).not.toBeNull();
    });

    it('rejects maxOutput < 0', () => {
        const model = { ...MODEL_CATALOG['@cf/zai-org/glm-5.2']!, maxOutput: -1 };
        expect(validateModelPricingDoc({ models: { m: model }, gatewayFee: 1.05, margin: 1 })).not.toBeNull();
    });

    it('accepts maxOutput == 0 (embeddings-style, input-only model)', () => {
        const model = { ...MODEL_CATALOG['@cf/baai/bge-small-en-v1.5']! };
        expect(validateModelPricingDoc({ models: { m: model }, gatewayFee: 1.05, margin: 1 })).toBeNull();
    });

    it('rejects an invalid route string', () => {
        const model = { ...MODEL_CATALOG['@cf/zai-org/glm-5.2']!, route: 'openai-direct' };
        expect(validateModelPricingDoc({ models: { m: model }, gatewayFee: 1.05, margin: 1 })).not.toBeNull();
    });

    it.each(['workers-ai', 'unified', 'direct'] as const)('accepts route %s with the right shape', (route) => {
        const base = { ...MODEL_CATALOG['@cf/zai-org/glm-5.2']!, route };
        const model = route === 'unified' ? { ...base, wireFormat: 'chat' as const } : base;
        expect(validateModelPricingDoc({ models: { m: model }, gatewayFee: 1.05, margin: 1 })).toBeNull();
    });

    it('rejects route:unified with no wireFormat', () => {
        const model = { ...MODEL_CATALOG['xai/grok-4.6']!, wireFormat: undefined };
        expect(validateModelPricingDoc({ models: { m: model }, gatewayFee: 1.05, margin: 1 })).not.toBeNull();
    });

    it('accepts a valid longContext block', () => {
        const model = { ...MODEL_CATALOG['xai/grok-4.6']! }; // already carries a longContext block
        expect(validateModelPricingDoc({ models: { m: model }, gatewayFee: 1.05, margin: 1 })).toBeNull();
    });

    it('rejects longContext.thresholdTokens <= 0', () => {
        const model = { ...MODEL_CATALOG['xai/grok-4.6']!, longContext: { ...MODEL_CATALOG['xai/grok-4.6']!.longContext!, thresholdTokens: 0 } };
        expect(validateModelPricingDoc({ models: { m: model }, gatewayFee: 1.05, margin: 1 })).not.toBeNull();
    });

    it('rejects a negative longContext rate', () => {
        const model = { ...MODEL_CATALOG['xai/grok-4.6']!, longContext: { ...MODEL_CATALOG['xai/grok-4.6']!.longContext!, outputCostPer1M: -5 } };
        expect(validateModelPricingDoc({ models: { m: model }, gatewayFee: 1.05, margin: 1 })).not.toBeNull();
    });

    it('rejects gatewayFee < 1', () => {
        expect(validateModelPricingDoc({ ...VALID_PRICING_DOC, gatewayFee: 0.99 })).not.toBeNull();
    });

    it('accepts gatewayFee == 1', () => {
        expect(validateModelPricingDoc({ ...VALID_PRICING_DOC, gatewayFee: 1 })).toBeNull();
    });

    it('rejects margin < 1', () => {
        expect(validateModelPricingDoc({ ...VALID_PRICING_DOC, margin: 0.5 })).not.toBeNull();
    });

    it('accepts margin == 1', () => {
        expect(validateModelPricingDoc({ ...VALID_PRICING_DOC, margin: 1 })).toBeNull();
    });
});
