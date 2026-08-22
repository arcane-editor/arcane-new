// ─── Effort tiers (model routing per reasoning level) ────
//
// THE single source of truth for which model each tier maps to. The editor
// sends an abstract `reasoningLevel` (low|mid|high); model choice happens here.
//
// Every model routes through Cloudflare: `@cf/*` ids bill as Workers AI,
// `openai/*` and `xai/*` bill as third-party via AI Gateway unified billing.
// There is no external-provider path and no fallback model — one provider
// means an outage takes every tier down together, so a fallback map could
// not help.
//
// Internal keys stay low/mid/high; only the labels are user-facing. The
// legacy `super` wire value maps to `high` (see getIntensityConfig).
//
// NOTE: INTENSITY_CONFIG/INLINE_MODEL below are the CURRENT routing (still
// consumed directly by routing.ts/inline.ts). DEFAULT_MODEL_ROUTING further
// down is the NEW routing shape (app-config.ts's ModelRoutingDoc) — the seed
// a later task swaps the consumers over to; it is not yet wired to any route.

import type { ModelRoutingDoc } from '../lib/app-config.ts';

export type Intensity = 'low' | 'mid' | 'high';

export interface IntensityConfig {
    model: string;
    label: string;
    description: string;
}

export const INTENSITY_CONFIG: Record<Intensity, IntensityConfig> = {
    low: {
        // Served via gateway BYOK (owner's OpenAI key stored on the AI
        // Gateway), NOT unified billing: CF's unified-billing run catalog
        // rejects the whole GPT-5.6 family as of 2026-08-15 (AiGatewayError
        // 7003 on any 5.6 id while gpt-5.4*/5.1 validate), but BYOK requests
        // pass through to OpenAI unvalidated. See the 2026-08-15 cost-
        // optimization manual checklist for the verification trail.
        model: 'openai/gpt-5.6-luna',
        label: 'Standard',
        description: 'Day-to-day coding',
    },
    mid: {
        model: '@cf/zai-org/glm-5.2',
        label: 'Deep Think',
        description: 'Extended reasoning for tricky problems',
    },
    high: {
        model: 'xai/grok-4.6',
        label: 'Max',
        description: 'Maximum capability for complex work',
    },
};

/** Model for inline (tab) completions — cheap, large context, Workers AI. */
export const INLINE_MODEL = '@cf/zai-org/glm-4.7-flash';

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
