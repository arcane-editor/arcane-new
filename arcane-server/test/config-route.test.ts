import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { seedPasswordUser, tokenFor } from './helpers.ts';
import { putConfigDoc, clearConfigCache } from '../src/lib/app-config.ts';
import { MODEL_CATALOG } from '../src/lib/costs.ts';
import { SPARK_MODEL } from '../src/config/plans.ts';
import type { ModelPricingDoc } from '../src/lib/app-config.ts';
import type { HarnessLimitsDoc } from '../src/config/plans.ts';
import type { UserRow } from '../src/lib/db.ts';

interface ConfigTier {
    id: string;
    label: string;
    description: string;
    allowed: boolean;
    hasPreplanning: boolean;
    contextWindow: number;
    pricingCliffTokens: number | null;
    maxModelCalls: number;
}

interface ConfigResponse {
    plan: string;
    planLabel: string;
    features: { inline: boolean; acp: boolean; topups: boolean };
    tiers: ConfigTier[];
}

async function getConfig(token?: string): Promise<Response> {
    return SELF.fetch('https://example.com/v1/config', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
}

async function setPlan(userId: number, plan: string): Promise<void> {
    await env.arcane_db.prepare('UPDATE users SET plan = ? WHERE id = ?').bind(plan, userId).run();
}

function tierById(body: ConfigResponse, id: string): ConfigTier {
    const tier = body.tiers.find((t) => t.id === id);
    if (!tier) throw new Error(`tier ${id} missing from response`);
    return tier;
}

describe('GET /v1/config', () => {
    it('401s with no token', async () => {
        const res = await getConfig();
        expect(res.status).toBe(401);
    });

    it('free user: features all false, only low allowed', async () => {
        const user = await seedPasswordUser('config-free@test.dev', 'password123');
        const token = await tokenFor(user);
        const res = await getConfig(token);
        expect(res.status).toBe(200);
        const body = await res.json<ConfigResponse>();

        expect(body.plan).toBe('free');
        expect(body.planLabel).toBe('Free');
        expect(body.features).toEqual({ inline: false, acp: false, topups: false });
        expect(tierById(body, 'low').allowed).toBe(true);
        expect(tierById(body, 'mid').allowed).toBe(false);
        expect(tierById(body, 'high').allowed).toBe(false);
    });

    it('max-plan user: all tiers allowed, features all true', async () => {
        const user = await seedPasswordUser('config-max@test.dev', 'password123');
        await setPlan(user.id, 'max');
        const token = await tokenFor(user);
        const res = await getConfig(token);
        expect(res.status).toBe(200);
        const body = await res.json<ConfigResponse>();

        expect(body.plan).toBe('max');
        expect(body.planLabel).toBe('Max');
        expect(body.features).toEqual({ inline: true, acp: true, topups: true });
        expect(tierById(body, 'low').allowed).toBe(true);
        expect(tierById(body, 'mid').allowed).toBe(true);
        expect(tierById(body, 'high').allowed).toBe(true);
    });

    it('pro-plan user: low+mid allowed, high not', async () => {
        const user = await seedPasswordUser('config-pro@test.dev', 'password123');
        await setPlan(user.id, 'pro');
        const token = await tokenFor(user);
        const res = await getConfig(token);
        expect(res.status).toBe(200);
        const body = await res.json<ConfigResponse>();

        expect(body.plan).toBe('pro');
        expect(body.planLabel).toBe('Pro');
        expect(tierById(body, 'low').allowed).toBe(true);
        expect(tierById(body, 'mid').allowed).toBe(true);
        expect(tierById(body, 'high').allowed).toBe(false);
    });

    it('hasPreplanning follows DEFAULT_MODEL_ROUTING: low false (same model both roles), mid+high true', async () => {
        const user = await seedPasswordUser('config-preplan@test.dev', 'password123');
        const token = await tokenFor(user);
        const res = await getConfig(token);
        const body = await res.json<ConfigResponse>();

        expect(tierById(body, 'low').hasPreplanning).toBe(false);
        expect(tierById(body, 'mid').hasPreplanning).toBe(true);
        expect(tierById(body, 'high').hasPreplanning).toBe(true);
    });

    // This number has now flipped twice. Spark's conservative 131_072 seed was
    // the smallest window on every tier until 2026-08-27, when glm-5.3-flash
    // took the executor slots and each tier rose to its own planner's window
    // (1,048,576 / 1,048,576 / 400,000). Spark 1.3 took those slots back on
    // 2026-09-03, so its seed is the binding constraint everywhere again and
    // all three tiers report the same number — including high, whose
    // gpt-5.6-sol planner (400_000) is no longer the smallest.
    //
    // This is a real product consequence, not bookkeeping: the editor derives
    // its compaction threshold from this value, so every tier compacts ~8x
    // sooner than it did the day before. Raising spark's catalog window (or
    // rolling back to FLASH_MODEL) is what moves it.
    it('contextWindow: every tier = spark\'s 131_072 seed, the smallest in each tier\'s lineup', async () => {
        const user = await seedPasswordUser('config-ctxwin@test.dev', 'password123');
        const token = await tokenFor(user);
        const res = await getConfig(token);
        const body = await res.json<ConfigResponse>();

        expect(tierById(body, 'low').contextWindow).toBe(131_072);
        expect(tierById(body, 'mid').contextWindow).toBe(131_072);
        expect(tierById(body, 'high').contextWindow).toBe(131_072);
    });

    it('contextWindow: a model_pricing override lowering the executor\'s window changes the derived high-tier value', async () => {
        clearConfigCache();
        const user = await seedPasswordUser('config-ctxwin-override@test.dev', 'password123');
        const token = await tokenFor(user);

        const executorOverride: ModelPricingDoc = {
            models: {
                [SPARK_MODEL]: {
                    ...MODEL_CATALOG[SPARK_MODEL]!,
                    contextWindow: 100_000,
                },
            },
            gatewayFee: 1.05,
            margin: 1.0,
        };
        await putConfigDoc(env.arcane_db, 'model_pricing', executorOverride);
        clearConfigCache();

        const res = await getConfig(token);
        const body = await res.json<ConfigResponse>();
        // Now the smallest of (sol 400_000, executor 100_000, glm 1_048_576)
        // is the overridden executor, below even spark's own 131_072 seed —
        // the derived value follows the override, not the catalog.
        expect(tierById(body, 'high').contextWindow).toBe(100_000);

        clearConfigCache(); // leave a clean cache for any test file sharing this isolate
    });

    // Grok's 200k cliff was the ONLY repricing cliff in the routed lineup, and
    // it sat on the high tier. Retiring grok on 2026-08-30 removed it: every
    // routed model is now flat-priced, so no tier reports a cliff at all. The
    // editor uses this to warn before a request gets suddenly more expensive —
    // a null here means there is genuinely nothing to warn about.
    it('pricingCliffTokens: null on every tier once grok (the only cliff model) is unrouted', async () => {
        const user = await seedPasswordUser('config-cliff@test.dev', 'password123');
        const token = await tokenFor(user);
        const res = await getConfig(token);
        const body = await res.json<ConfigResponse>();

        expect(tierById(body, 'high').pricingCliffTokens).toBeNull();
        expect(tierById(body, 'mid').pricingCliffTokens).toBeNull();
        expect(tierById(body, 'low').pricingCliffTokens).toBeNull();
    });

    it('maxModelCalls: defaults to {1000,1600,2000} (DEFAULT_HARNESS_LIMITS)', async () => {
        const user = await seedPasswordUser('config-harness-default@test.dev', 'password123');
        const token = await tokenFor(user);
        const res = await getConfig(token);
        const body = await res.json<ConfigResponse>();

        expect(tierById(body, 'low').maxModelCalls).toBe(1000);
        expect(tierById(body, 'mid').maxModelCalls).toBe(1600);
        expect(tierById(body, 'high').maxModelCalls).toBe(2000);
    });

    it('maxModelCalls: a harness_limits override is served after clearConfigCache', async () => {
        clearConfigCache();
        const user = await seedPasswordUser('config-harness-override@test.dev', 'password123');
        const token = await tokenFor(user);

        const override: HarnessLimitsDoc = {
            tiers: { low: { maxModelCalls: 42 }, mid: { maxModelCalls: 84 }, high: { maxModelCalls: 168 } },
        };
        await putConfigDoc(env.arcane_db, 'harness_limits', override);
        clearConfigCache();

        const res = await getConfig(token);
        const body = await res.json<ConfigResponse>();
        expect(tierById(body, 'low').maxModelCalls).toBe(42);
        expect(tierById(body, 'mid').maxModelCalls).toBe(84);
        expect(tierById(body, 'high').maxModelCalls).toBe(168);

        clearConfigCache(); // leave a clean cache for any test file sharing this isolate
    });

    it('unverified-email user still gets 200 (auth only, no verified-email gate)', async () => {
        const user: UserRow = await seedPasswordUser('config-unverified@test.dev', 'password123', { verified: false });
        const token = await tokenFor(user);
        const res = await getConfig(token);
        expect(res.status).toBe(200);
    });
});
