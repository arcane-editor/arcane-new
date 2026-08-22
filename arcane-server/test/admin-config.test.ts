import { describe, it, expect, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { adminToken, authedGet, jsonPut, seedPasswordUser, tokenFor } from './helpers.ts';
import { clearConfigCache, getEffectivePricing } from '../src/lib/app-config.ts';
import type { ModelRoutingDoc, ModelPricingDoc } from '../src/lib/app-config.ts';
import { DEFAULT_MODEL_ROUTING } from '../src/config/plans.ts';
import { MODEL_CATALOG, type ModelInfo } from '../src/lib/costs.ts';
import { GATEWAY_FEE, MARGIN } from '../src/config/tiers.ts';

// Every test in this file shares one D1 instance (vitest-pool-workers gives
// each *file* fresh storage, but tests within it run sequentially against
// the same tables) — tests are ordered so state built by an earlier one is
// exactly what a later one needs (e.g. the "fresh DB" GET must run before
// any PUT in this file touches model_routing/model_pricing).
beforeEach(() => clearConfigCache());

const VALID_ROUTING_DOC: ModelRoutingDoc = {
    tiers: {
        low:  { planner: '@cf/zai-org/glm-5.2', executor: '@cf/zai-org/glm-5.2' },
        mid:  { planner: 'xai/grok-4.6', executor: '@cf/zai-org/glm-5.2' },
        high: { planner: 'openai/gpt-5.6-luna', executor: '@cf/zai-org/glm-5.2', executorHard: 'xai/grok-4.6' },
    },
    inline: '@cf/qwen/qwen3-30b-a3b-fp8',
};

interface ConfigGetBody<T> {
    value: T;
    isDefault: boolean;
    updatedAt: string | null;
}

describe('GET/PUT /v1/admin/config/models', () => {
    it('fresh DB -> isDefault:true, value === DEFAULT_MODEL_ROUTING, updatedAt null', async () => {
        const token = await adminToken();
        const res = await authedGet('/v1/admin/config/models', token);
        expect(res.status).toBe(200);
        const body = await res.json<ConfigGetBody<ModelRoutingDoc>>();
        expect(body.isDefault).toBe(true);
        expect(body.value).toEqual(DEFAULT_MODEL_ROUTING);
        expect(body.updatedAt).toBeNull();
    });

    it('PUT rejects a doc missing a tier -> 400 invalid_config, validator message names it; nothing persisted', async () => {
        const token = await adminToken();
        const bad = {
            tiers: { low: VALID_ROUTING_DOC.tiers.low, mid: VALID_ROUTING_DOC.tiers.mid }, // high missing
            inline: VALID_ROUTING_DOC.inline,
        };
        const res = await jsonPut('/v1/admin/config/models', bad, token);
        expect(res.status).toBe(400);
        const errBody = await res.json<{ error: string; code: string }>();
        expect(errBody.code).toBe('invalid_config');
        expect(errBody.error).toMatch(/high/);

        const after = await authedGet('/v1/admin/config/models', token);
        const afterBody = await after.json<ConfigGetBody<ModelRoutingDoc>>();
        expect(afterBody.isDefault).toBe(true);
        expect(afterBody.value).toEqual(DEFAULT_MODEL_ROUTING);
    });

    it('PUT rejects an unknown model id -> 400 invalid_config; nothing persisted', async () => {
        const token = await adminToken();
        const bad: ModelRoutingDoc = {
            ...VALID_ROUTING_DOC,
            tiers: { ...VALID_ROUTING_DOC.tiers, low: { planner: 'nope/unknown-model', executor: '@cf/zai-org/glm-5.2' } },
        };
        const res = await jsonPut('/v1/admin/config/models', bad, token);
        expect(res.status).toBe(400);
        const errBody = await res.json<{ error: string; code: string }>();
        expect(errBody.code).toBe('invalid_config');
        expect(errBody.error).toMatch(/nope\/unknown-model/);

        const after = await authedGet('/v1/admin/config/models', token);
        expect((await after.json<ConfigGetBody<ModelRoutingDoc>>()).isDefault).toBe(true);
    });

    it('PUT rejects a non-@cf/ inline model -> 400 invalid_config; nothing persisted', async () => {
        const token = await adminToken();
        const bad: ModelRoutingDoc = { ...VALID_ROUTING_DOC, inline: 'xai/grok-4.6' };
        const res = await jsonPut('/v1/admin/config/models', bad, token);
        expect(res.status).toBe(400);
        const errBody = await res.json<{ error: string; code: string }>();
        expect(errBody.code).toBe('invalid_config');
        expect(errBody.error).toMatch(/@cf\//);

        const after = await authedGet('/v1/admin/config/models', token);
        expect((await after.json<ConfigGetBody<ModelRoutingDoc>>()).isDefault).toBe(true);
    });

    it('PUT accepts a valid doc -> {ok:true}; subsequent GET: isDefault:false, round-trips, updatedAt non-null', async () => {
        const token = await adminToken();
        const put = await jsonPut('/v1/admin/config/models', VALID_ROUTING_DOC, token);
        expect(put.status).toBe(200);
        expect(await put.json()).toEqual({ ok: true });

        const res = await authedGet('/v1/admin/config/models', token);
        const body = await res.json<ConfigGetBody<ModelRoutingDoc>>();
        expect(body.isDefault).toBe(false);
        expect(body.value).toEqual(VALID_ROUTING_DOC);
        expect(body.updatedAt).not.toBeNull();
    });
});

describe('GET/PUT /v1/admin/config/pricing', () => {
    const CUSTOM_MODEL_ID = 'test/custom-model-x';
    const customModelInfo: ModelInfo = { ...MODEL_CATALOG['@cf/zai-org/glm-5.2']! };

    it('fresh DB -> isDefault:true, value === {models:{}, gatewayFee:GATEWAY_FEE, margin:MARGIN}, updatedAt null', async () => {
        const token = await adminToken();
        const res = await authedGet('/v1/admin/config/pricing', token);
        expect(res.status).toBe(200);
        const body = await res.json<ConfigGetBody<ModelPricingDoc>>();
        expect(body.isDefault).toBe(true);
        expect(body.value).toEqual({ models: {}, gatewayFee: GATEWAY_FEE, margin: MARGIN });
        expect(body.updatedAt).toBeNull();
    });

    it('PUT rejects a negative rate -> 400 invalid_config; nothing persisted', async () => {
        const token = await adminToken();
        const bad = {
            models: { m: { ...MODEL_CATALOG['@cf/zai-org/glm-5.2']!, inputCostPer1M: -1 } },
            gatewayFee: 1.05, margin: 1.0,
        };
        const res = await jsonPut('/v1/admin/config/pricing', bad, token);
        expect(res.status).toBe(400);
        expect((await res.json<{ code: string }>()).code).toBe('invalid_config');

        const after = await authedGet('/v1/admin/config/pricing', token);
        expect((await after.json<ConfigGetBody<ModelPricingDoc>>()).isDefault).toBe(true);
    });

    it('PUT rejects a route:unified entry with no wireFormat -> 400 invalid_config; nothing persisted', async () => {
        const token = await adminToken();
        const bad = {
            models: { m: { ...MODEL_CATALOG['xai/grok-4.6']!, wireFormat: undefined } },
            gatewayFee: 1.05, margin: 1.0,
        };
        const res = await jsonPut('/v1/admin/config/pricing', bad, token);
        expect(res.status).toBe(400);
        expect((await res.json<{ code: string }>()).code).toBe('invalid_config');

        const after = await authedGet('/v1/admin/config/pricing', token);
        expect((await after.json<ConfigGetBody<ModelPricingDoc>>()).isDefault).toBe(true);
    });

    it('PUT rejects gatewayFee 0.9 -> 400 invalid_config; nothing persisted', async () => {
        const token = await adminToken();
        const bad = { models: {}, gatewayFee: 0.9, margin: 1.0 };
        const res = await jsonPut('/v1/admin/config/pricing', bad, token);
        expect(res.status).toBe(400);
        expect((await res.json<{ code: string }>()).code).toBe('invalid_config');

        const after = await authedGet('/v1/admin/config/pricing', token);
        expect((await after.json<ConfigGetBody<ModelPricingDoc>>()).isDefault).toBe(true);
    });

    it('orphan rule: cannot PUT pricing that drops a model the current routing doc references', async () => {
        const token = await adminToken();

        // 1. Add a brand-new model X, resolvable ONLY via this pricing doc
        //    (it is not a real MODEL_CATALOG entry).
        const addX = await jsonPut('/v1/admin/config/pricing',
            { models: { [CUSTOM_MODEL_ID]: customModelInfo }, gatewayFee: 1.05, margin: 1.0 }, token);
        expect(addX.status).toBe(200);

        // 2. Route mid.executor to X — valid right now because the effective
        //    catalog (MODEL_CATALOG + the doc from step 1) resolves it.
        const routeToX: ModelRoutingDoc = {
            tiers: {
                low:  { planner: '@cf/zai-org/glm-5.2', executor: '@cf/zai-org/glm-5.2' },
                mid:  { planner: 'xai/grok-4.6', executor: CUSTOM_MODEL_ID },
                high: { planner: 'openai/gpt-5.6-luna', executor: '@cf/zai-org/glm-5.2', executorHard: 'xai/grok-4.6' },
            },
            inline: '@cf/qwen/qwen3-30b-a3b-fp8',
        };
        const putRouting = await jsonPut('/v1/admin/config/models', routeToX, token);
        expect(putRouting.status).toBe(200);

        // 3. Replacing the pricing doc with one that no longer defines X
        //    would orphan the model mid.executor currently routes to.
        const dropX = await jsonPut('/v1/admin/config/pricing',
            { models: {}, gatewayFee: 1.05, margin: 1.0 }, token);
        expect(dropX.status).toBe(400);
        const body = await dropX.json<{ error: string; code: string }>();
        expect(body.code).toBe('invalid_config');
        expect(body.error).toMatch(new RegExp(CUSTOM_MODEL_ID.replace(/\//g, '\\/')));

        // Nothing persisted by the rejected PUT — X is still defined.
        const after = await authedGet('/v1/admin/config/pricing', token);
        const afterBody = await after.json<ConfigGetBody<ModelPricingDoc>>();
        expect(afterBody.value.models[CUSTOM_MODEL_ID]).toBeDefined();
    });

    it('PUT accepted -> subsequent getEffectivePricing (after clearConfigCache) reflects the override', async () => {
        const token = await adminToken();
        // Keeps CUSTOM_MODEL_ID defined (still routed to by the previous
        // test's leftover model_routing doc) while overriding a real
        // catalog model's price.
        const doc = {
            models: {
                [CUSTOM_MODEL_ID]: customModelInfo,
                '@cf/zai-org/glm-5.2': { ...MODEL_CATALOG['@cf/zai-org/glm-5.2']!, outputCostPer1M: 999 },
            },
            gatewayFee: 1.05, margin: 1.0,
        };
        const put = await jsonPut('/v1/admin/config/pricing', doc, token);
        expect(put.status).toBe(200);
        expect(await put.json()).toEqual({ ok: true });

        clearConfigCache();
        const pricing = await getEffectivePricing(env.arcane_db);
        expect(pricing.catalog['@cf/zai-org/glm-5.2']!.outputCostPer1M).toBe(999);
    });
});

describe('auth on the four config routes', () => {
    const routes: Array<{ method: 'GET' | 'PUT'; path: string; body?: unknown }> = [
        { method: 'GET', path: '/v1/admin/config/models' },
        { method: 'PUT', path: '/v1/admin/config/models', body: VALID_ROUTING_DOC },
        { method: 'GET', path: '/v1/admin/config/pricing' },
        { method: 'PUT', path: '/v1/admin/config/pricing', body: { models: {}, gatewayFee: 1.05, margin: 1.0 } },
    ];

    it.each(routes)('401 without a token: $method $path', async ({ method, path, body }) => {
        const res = await SELF.fetch(`https://example.com${path}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        });
        expect(res.status).toBe(401);
    });

    it.each(routes)('403 with a non-admin user token: $method $path', async ({ method, path, body }) => {
        const user = await seedPasswordUser(`nonadmin-${crypto.randomUUID()}@test.dev`, 'password123');
        const token = await tokenFor(user);
        const res = await SELF.fetch(`https://example.com${path}`, {
            method,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: body ? JSON.stringify(body) : undefined,
        });
        expect(res.status).toBe(403);
    });

    it('the env-admin login token (Task 6) also passes GET /v1/admin/config/models', async () => {
        const res = await SELF.fetch('https://example.com/v1/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'sourav.das120699@gmail.com', password: 'test-admin-password' }),
        });
        expect(res.status).toBe(200);
        const { token } = await res.json<{ token: string }>();
        const configRes = await authedGet('/v1/admin/config/models', token);
        expect(configRes.status).toBe(200);
    });
});
