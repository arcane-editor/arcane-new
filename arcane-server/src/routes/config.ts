import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.ts';
import type { AuthPayload } from '../middleware/auth.ts';
import type { AppEnv } from '../types.ts';
import { getUserBillingRow } from '../lib/db.ts';
import { getModelRouting, getEffectivePricing, getHarnessLimits } from '../lib/app-config.ts';
import type { TierRouting } from '../lib/app-config.ts';
import type { ModelInfo } from '../lib/costs.ts';
import { getContextWindow } from '../lib/costs.ts';
import { TIERS, isTierAllowed, isPaidPlan, isTierId } from '../config/tiers.ts';
import type { Intensity } from '../config/plans.ts';
import { INTENSITY_CONFIG } from '../config/plans.ts';

export const configRouter = new Hono<AppEnv>();

const INTENSITIES: readonly Intensity[] = ['low', 'mid', 'high'];

/** The role-model ids a tier's routing can name, in a fixed order. Filters
 *  out `executorHard` when a tier doesn't set one. */
function roleModels(tier: TierRouting): string[] {
    const models = [tier.planner, tier.executor];
    if (tier.executorHard) models.push(tier.executorHard);
    return models;
}

/** Smallest contextWindow across a tier's role models (planner/executor/
 *  executorHard). Pure + catalog-driven so it unit-tests without a Worker. */
export function minContextWindow(tier: TierRouting, catalog: Record<string, ModelInfo>): number {
    return Math.min(...roleModels(tier).map((m) => getContextWindow(m, catalog)));
}

/** Smallest longContext.thresholdTokens across a tier's role models that
 *  define one, or null when none of them do. */
export function minPricingCliffTokens(tier: TierRouting, catalog: Record<string, ModelInfo>): number | null {
    const cliffs = roleModels(tier)
        .map((m) => catalog[m]?.longContext?.thresholdTokens)
        .filter((t): t is number => typeof t === 'number');
    return cliffs.length > 0 ? Math.min(...cliffs) : null;
}

configRouter.get('/v1/config', authMiddleware(), async (c) => {
    const user = c.get('user') as AuthPayload;
    const db = c.env.arcane_db;
    const userId = parseInt(user.sub);

    const billing = await getUserBillingRow(db, userId);
    const plan = billing?.plan ?? 'free';
    const planId = isTierId(plan) ? plan : 'free';

    const routing = await getModelRouting(db);
    const pricing = await getEffectivePricing(db);
    const limits = await getHarnessLimits(db);

    return c.json({
        plan,
        planLabel: TIERS[planId as keyof typeof TIERS].name,
        features: {
            inline: isPaidPlan(plan),
            acp: isPaidPlan(plan),
            topups: isPaidPlan(plan),
        },
        tiers: INTENSITIES.map((t) => {
            const tierRouting = routing.tiers[t];
            return {
                id: t,
                label: INTENSITY_CONFIG[t].label,
                description: INTENSITY_CONFIG[t].description,
                allowed: isTierAllowed(plan, t),
                hasPreplanning: tierRouting.planner !== tierRouting.executor,
                contextWindow: minContextWindow(tierRouting, pricing.catalog),
                pricingCliffTokens: minPricingCliffTokens(tierRouting, pricing.catalog),
                maxModelCalls: limits.tiers[t].maxModelCalls,
            };
        }),
    });
});
