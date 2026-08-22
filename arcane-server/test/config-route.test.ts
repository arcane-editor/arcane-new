import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { seedPasswordUser, tokenFor } from './helpers.ts';
import { putConfigDoc, clearConfigCache } from '../src/lib/app-config.ts';
import { MODEL_CATALOG } from '../src/lib/costs.ts';
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

    it('hasPreplanning follows DEFAULT_MODEL_ROUTING: low false (spark/spark), mid+high true', async () => {
        const user = await seedPasswordUser('config-preplan@test.dev', 'password123');
        const token = await tokenFor(user);
        const res = await getConfig(token);
        const body = await res.json<ConfigResponse>();

        expect(tierById(body, 'low').hasPreplanning).toBe(false);
        expect(tierById(body, 'mid').hasPreplanning).toBe(true);
        expect(tierById(body, 'high').hasPreplanning).toBe(true);
    });

    it('contextWindow: high tier = min(sol 400_000, spark 131_072, grok 500_000) = 131_072 with seed catalog', async () => {
        const user = await seedPasswordUser('config-ctxwin@test.dev', 'password123');
        const token = await tokenFor(user);
        const res = await getConfig(token);
        const body = await res.json<ConfigResponse>();

        expect(tierById(body, 'high').contextWindow).toBe(131_072);
    });

    it('contextWindow: a model_pricing override raising spark\'s window changes the derived high-tier value', async () => {
        clearConfigCache();
        const user = await seedPasswordUser('config-ctxwin-override@test.dev', 'password123');
        const token = await tokenFor(user);

        const sparkOverride: ModelPricingDoc = {
            models: {
                'spark/muse-spark-1.2-contributor': {
                    ...MODEL_CATALOG['spark/muse-spark-1.2-contributor']!,
                    contextWindow: 999_999,
                },
            },
            gatewayFee: 1.05,
            margin: 1.0,
        };
        await putConfigDoc(env.arcane_db, 'model_pricing', sparkOverride);
        clearConfigCache();

        const res = await getConfig(token);
        const body = await res.json<ConfigResponse>();
        // Now the smallest of (sol 400_000, spark 999_999, grok 500_000) is sol.
        expect(tierById(body, 'high').contextWindow).toBe(400_000);

        clearConfigCache(); // leave a clean cache for any test file sharing this isolate
    });

    it('pricingCliffTokens: high tier = 200_000 (grok\'s cliff) with seed data; low tier (spark/spark, no cliffs) = null', async () => {
        const user = await seedPasswordUser('config-cliff@test.dev', 'password123');
        const token = await tokenFor(user);
        const res = await getConfig(token);
        const body = await res.json<ConfigResponse>();

        expect(tierById(body, 'high').pricingCliffTokens).toBe(200_000);
        expect(tierById(body, 'low').pricingCliffTokens).toBeNull();
    });

    it('unverified-email user still gets 200 (auth only, no verified-email gate)', async () => {
        const user: UserRow = await seedPasswordUser('config-unverified@test.dev', 'password123', { verified: false });
        const token = await tokenFor(user);
        const res = await getConfig(token);
        expect(res.status).toBe(200);
    });
});
