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

/** Direct OpenAI-compatible provider (owner's Spark key; no CF gateway, no
 *  Workers AI, no Cloudflare in the request path at all) — see costs.ts's
 *  MODEL_CATALOG entry for pricing/route detail.
 *
 *  ROUTED since 2026-09-03: it serves the executor slot on all three tiers
 *  and the Standard tier's planner, taking every slot FLASH_MODEL held. It is
 *  also the only model that may run at 'max' reasoning effort — config/
 *  routing.ts clamps every other provider to 'xhigh' (see its ROLE_EFFORT
 *  table for which slot asks for which).
 *
 *  Note the failure-domain trade this makes: spark is the one routed model
 *  that does NOT go through the AI Gateway, so it has no gateway caching,
 *  no gateway logs, and its own availability. */
export const SPARK_MODEL = 'spark/muse-spark-1.3-contributor';

/** Superseded by SPARK_MODEL on 2026-09-03. Unrouted, and kept for the same
 *  reason every retired model is: usage rows are keyed by model id, so
 *  deleting the catalog entry would silently zero the cost of every
 *  historical debit against it. */
export const LEGACY_SPARK_MODEL = 'spark/muse-spark-1.2-contributor';

/** Workers-AI executor across all three tiers, and the low tier's planner,
 *  from 2026-08-27 until 2026-09-03 — when SPARK_MODEL took every one of
 *  those slots back. Unrouted now, and kept as the one-line rollback: it is
 *  cheaper on paper ($0.15/$0.50 against spark's flat $0.20 seed), it is the
 *  only one of the two on the AI-Gateway path, and its 1,048,576 window is 8x
 *  spark's conservative 131,072 seed — that seed is once again the binding
 *  constraint on every tier's usable context (routes/config.ts derives each
 *  tier's window as the MINIMUM across its role models). Swap it back into
 *  the tiers below to undo the 2026-09-03 change wholesale. */
export const FLASH_MODEL = '@cf/zai-org/glm-5.3-flash';

/** Deep-Think PLANNER, and the Max tier's hard-task executor.
 *  Took over both slots from `xai/grok-4.6` on 2026-08-30: cheaper on every
 *  axis ($1.40/$4.40 vs $2.00/$6.00), a real cached-input rate ($0.26, where
 *  grok published none and cache hits were billed at the full input rate),
 *  2x the context (1,048,576 vs 500,000), and no long-context cliff — grok
 *  doubled the price of the ENTIRE request above 200k input, at exactly the
 *  sizes Deep Think exists for. See costs.ts's MODEL_CATALOG entry.
 *
 *  Untouched by the 2026-09-03 spark swap, which only took the executor slots
 *  and the Standard planner. Because it is not spark, config/routing.ts
 *  clamps both of its slots to 'xhigh' effort. */
export const PLANNER_MODEL = '@cf/zai-org/glm-5.3';

/** Code-default model routing — served whenever the app_config table has no
 *  valid 'model_routing' doc. The admin panel overrides at runtime.
 *
 *  NOTE for anyone changing a model here: a deployed environment whose D1
 *  app_config table already holds a 'model_routing' doc IGNORES this table
 *  (lib/app-config.ts's getModelRouting). Editing this file alone changes
 *  nothing there — the doc has to be rewritten through the admin config route. */
export const DEFAULT_MODEL_ROUTING: ModelRoutingDoc = {
    tiers: {
        low:  { planner: SPARK_MODEL, executor: SPARK_MODEL },
        mid:  { planner: PLANNER_MODEL, executor: SPARK_MODEL },
        high: { planner: 'openai/gpt-5.6-sol', executor: SPARK_MODEL, executorHard: PLANNER_MODEL },
    },
    inline: '@cf/qwen/qwen3-30b-a3b-fp8',
};

// ─── Harness turn-governor limits ───────────────────────────────────
//
// Per-tier cap on model calls within one composer submit (the editor's
// turn governor — see editor/AI-SPEC.md and
// features/ai-panel/services/turn-governor.ts). Served to the editor over
// GET /v1/config's `maxModelCalls` field (routes/config.ts) via the runtime
// 'harness_limits' app_config document (lib/app-config.ts's
// getHarnessLimits), with DEFAULT_HARNESS_LIMITS below as the code default
// served whenever that table has no valid row. The admin panel's Harness tab
// overrides at runtime.

export interface HarnessTierLimits {
    maxModelCalls: number;
}

export interface HarnessLimitsDoc {
    tiers: Record<Intensity, HarnessTierLimits>;
}

/** Code-default harness limits — served whenever the app_config table has no
 *  valid 'harness_limits' doc. Mirrors the editor's hardcoded fallbacks
 *  (`FALLBACK_TURN_CAPS` in stores/server-config.ts, `DEFAULT_TURN_CAPS` in
 *  features/ai-panel/services/turn-governor.ts) — keep all three in sync;
 *  editing this file alone changes nothing for a deployed environment whose
 *  D1 app_config table already holds a 'harness_limits' doc. */
export const DEFAULT_HARNESS_LIMITS: HarnessLimitsDoc = {
    tiers: {
        low: { maxModelCalls: 1000 },
        mid: { maxModelCalls: 1600 },
        high: { maxModelCalls: 2000 },
    },
};
