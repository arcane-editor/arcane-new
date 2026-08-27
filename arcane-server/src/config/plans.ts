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
 *  costs.ts's MODEL_CATALOG entry for pricing/route detail.
 *
 *  UNROUTED since 2026-08-27: EXECUTOR_MODEL below took every slot this held.
 *  Kept as the named rollback (swap it back into the tiers) and because the
 *  catalog entry it points at still has to exist for historical usage rows. */
export const SPARK_MODEL = 'spark/muse-spark-1.2-contributor';

/** Workers-AI executor across all three tiers, and the low tier's planner.
 *  Took over from SPARK_MODEL on 2026-08-27: cheaper input ($0.15 vs $0.20/M),
 *  a real cached-input rate ($0.03/M, where the direct route had none), 8x the
 *  context (1,048,576 vs 131,072 — every tier's usable window was bottlenecked
 *  on spark's), and it puts the executor back on the AI-Gateway path that the
 *  direct route opted out of. See costs.ts's MODEL_CATALOG entry. */
export const EXECUTOR_MODEL = '@cf/zai-org/glm-5.3-flash';

/** Code-default model routing — served whenever the app_config table has no
 *  valid 'model_routing' doc. The admin panel overrides at runtime.
 *
 *  NOTE for anyone changing a model here: a deployed environment whose D1
 *  app_config table already holds a 'model_routing' doc IGNORES this table
 *  (lib/app-config.ts's getModelRouting). Editing this file alone changes
 *  nothing there — the doc has to be rewritten through the admin config route. */
export const DEFAULT_MODEL_ROUTING: ModelRoutingDoc = {
    tiers: {
        low:  { planner: EXECUTOR_MODEL, executor: EXECUTOR_MODEL },
        mid:  { planner: 'xai/grok-4.6', executor: EXECUTOR_MODEL },
        high: { planner: 'openai/gpt-5.6-sol', executor: EXECUTOR_MODEL, executorHard: 'xai/grok-4.6' },
    },
    inline: '@cf/qwen/qwen3-30b-a3b-fp8',
};
