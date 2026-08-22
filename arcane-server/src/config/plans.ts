// ─── Effort tiers (labels/entitlement) + model routing defaults ────
//
// INTENSITY_CONFIG is UI/entitlement metadata ONLY (label + description) —
// which model actually serves a tier is no longer pinned here. Model choice
// comes from the runtime `model_routing` app_config document (see
// lib/app-config.ts's getModelRouting), with DEFAULT_MODEL_ROUTING below as
// the code default served whenever that table has no valid row.
// config/routing.ts resolves the concrete model per send against whichever
// doc getModelRouting returns.
//
// Internal keys stay low/mid/high; only the labels are user-facing. The
// legacy `super` wire value maps to `high` (see getIntensityConfig).

import type { ModelRoutingDoc } from '../lib/app-config.ts';

export type Intensity = 'low' | 'mid' | 'high';

export interface IntensityConfig {
    label: string;
    description: string;
}

export const INTENSITY_CONFIG: Record<Intensity, IntensityConfig> = {
    low: {
        label: 'Standard',
        description: 'Day-to-day coding',
    },
    mid: {
        label: 'Deep Think',
        description: 'Extended reasoning for tricky problems',
    },
    high: {
        label: 'Max',
        description: 'Maximum capability for complex work',
    },
};

/** Default tier when the client sends none. Standard is where most users stay. */
export const DEFAULT_INTENSITY: Intensity = 'low';

export function getIntensityConfig(level: string): IntensityConfig | undefined {
    // `super` predates the three-tier ladder; older editor builds still send it.
    const normalized = level === 'super' ? 'high' : level;
    return INTENSITY_CONFIG[normalized as Intensity];
}

/** Direct OpenAI-compatible provider (owner's Spark key; no CF gateway) — see
 *  costs.ts's MODEL_CATALOG entry for pricing/route detail. */
export const SPARK_MODEL = 'spark/muse-spark-1.2-contributor';

/** Code-default model routing — served whenever the app_config table has no
 *  valid 'model_routing' doc. The admin panel overrides at runtime. */
export const DEFAULT_MODEL_ROUTING: ModelRoutingDoc = {
    tiers: {
        low:  { planner: SPARK_MODEL, executor: SPARK_MODEL },
        mid:  { planner: 'xai/grok-4.6', executor: SPARK_MODEL },
        high: { planner: 'openai/gpt-5.6-sol', executor: SPARK_MODEL, executorHard: 'xai/grok-4.6' },
    },
    inline: '@cf/qwen/qwen3-30b-a3b-fp8',
};
