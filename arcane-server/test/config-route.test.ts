import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { seedPasswordUser, tokenFor } from './helpers.ts';
import { putConfigDoc, clearConfigCache } from '../src/lib/app-config.ts';
import { MODEL_CATALOG } from '../src/lib/costs.ts';
import { EXECUTOR_MODEL } from '../src/config/plans.ts';
import type { ModelPricingDoc } from '../src/lib/app-config.ts';
import type { UserRow } from '../src/lib/db.ts';

interface ConfigTier {
    id: string;
    label: string;
    description: string;
    allowed: boolean;
    hasPreplanning: boolean;
    contextWindow: number;
    pricingCliffTokens: number | null;
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

    // Until 2026-08-27 the executor (spark, 131_072) was the smallest window on
    // every tier, so all three came back identical. glm-5.3-flash's 1,048,576
    // lifted that floor, and each tier now reports its own planner's window.
    // 2026-08-30: glm-5.3 replaced grok as the mid planner, so mid is no
    // longer pinned to grok's 500_000 — low and mid are both 1,048,576 now
    // and gpt-5.6-sol is the only remaining constraint anywhere.
    it('contextWindow: high tier = min(sol 400_000, glm-flash 1_048_576, glm 1_048_576) = 400_000 with seed catalog', async () => {
        const user = await seedPasswordUser('config-ctxwin@test.dev', 'password123');
        const token = await tokenFor(user);
        const res = await getConfig(token);
        const body = await res.json<ConfigResponse>();

        expect(tierById(body, 'high').contextWindow).toBe(400_000);
        expect(tierById(body, 'low').contextWindow).toBe(1_048_576);
        expect(tierById(body, 'mid').contextWindow).toBe(1_048_576);
    });

    it('contextWindow: a model_pricing override lowering the executor\'s window changes the derived high-tier value', async () => {
        clearConfigCache();
        const user = await seedPasswordUser('config-ctxwin-override@test.dev', 'password123');
        const token = await tokenFor(user);

        const executorOverride: ModelPricingDoc = {
            models: {
                [EXECUTOR_MODEL]: {
                    ...MODEL_CATALOG[EXECUTOR_MODEL]!,
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
        // is the executor — the derived value follows the override, not the seed.
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

    it('unverified-email user still gets 200 (auth only, no verified-email gate)', async () => {
        const user: UserRow = await seedPasswordUser('config-unverified@test.dev', 'password123', { verified: false });
        const token = await tokenFor(user);
        const res = await getConfig(token);
        expect(res.status).toBe(200);
    });
});
