// Model catalog for the AI tier ladder. Rates are VENDOR LIST PRICES verified
// 2026-08-13 (see the design doc). Two things make this non-trivial:
//
//  1. Cached input. Every frontier model prices a cache hit far below a fresh
//     token (glm-5.2: $0.26 vs $1.40). `estimateCost` bills them separately.
//  2. Long-context repricing. Some models reprice the ENTIRE request once the
//     input crosses a threshold — a cliff, not a gradient. A 200,001-token
//     Grok request costs double a 200,000-token one.
//
// `@cf/*` ids bill as Workers AI; everything else bills as a third-party model
// through AI Gateway unified billing. Third-party rates are set by the SERVING
// provider and are dashboard-only — confirm them before trusting these numbers.

export interface LongContextRates {
    /** Total input tokens above which the whole request reprices. */
    thresholdTokens: number;
    inputCostPer1M: number;
    outputCostPer1M: number;
    cachedInputCostPer1M: number;
}

export interface ModelInfo {
    route: 'workers-ai' | 'unified';
    inputCostPer1M: number;
    outputCostPer1M: number;
    cachedInputCostPer1M: number;
    contextWindow: number;
    maxOutput: number;
    longContext?: LongContextRates;
}

export const MODEL_CATALOG: Record<string, ModelInfo> = {
    // Standard — day-to-day coding. Stand-in for gpt-5.6-luna until
    // Cloudflare's run catalog onboards the 5.6 family (see plans.ts).
    // Pricing verified 2026-08-15 (developers.openai.com): $0.75/$0.075
    // cached (90% off, automatic)/$4.50; 400k context, 128k max output.
    // No long-context repricing published for the mini tier.
    'openai/gpt-5.4-mini': {
        route: 'unified',
        inputCostPer1M: 0.75, outputCostPer1M: 4.50, cachedInputCostPer1M: 0.075,
        contextWindow: 400_000, maxOutput: 128_000,
    },
    // Intended Standard model — NOT currently servable through the gateway
    // (run catalog lacks the 5.6 family); kept so the revert is one line.
    'openai/gpt-5.6-luna': {
        route: 'unified',
        inputCostPer1M: 0.20, outputCostPer1M: 1.20, cachedInputCostPer1M: 0.02,
        contextWindow: 1_050_000, maxOutput: 128_000,
        // Above 272k input OpenAI reprices at $0.40/$1.80. The long-context
        // CACHED rate is not published; 0.04 mirrors the 2x input scaling and
        // is the conservative assumption. Verify before relying on it.
        longContext: {
            thresholdTokens: 272_000,
            inputCostPer1M: 0.40, outputCostPer1M: 1.80, cachedInputCostPer1M: 0.04,
        },
    },
    // Deep Think — extended reasoning. Terminal-Bench 2.1 leader (81.0%).
    // Flat pricing: the only tier with no long-context cliff, which makes it
    // the correct choice for genuinely large-context work.
    '@cf/zai-org/glm-5.2': {
        route: 'workers-ai',
        inputCostPer1M: 1.40, outputCostPer1M: 4.40, cachedInputCostPer1M: 0.26,
        contextWindow: 262_144, maxOutput: 32_000,
    },
    // Max — frontier intelligence. Above 200k the whole request reprices.
    'xai/grok-4.6': {
        route: 'unified',
        // No sub-threshold cached rate is published; charging cache hits at the
        // full input rate over-estimates, which is the safe direction.
        inputCostPer1M: 2.00, outputCostPer1M: 6.00, cachedInputCostPer1M: 2.00,
        contextWindow: 500_000, maxOutput: 64_000,
        longContext: {
            thresholdTokens: 200_000,
            inputCostPer1M: 4.00, outputCostPer1M: 12.00, cachedInputCostPer1M: 1.00,
        },
    },
    // Inline (tab) completions.
    '@cf/zai-org/glm-4.7-flash': {
        route: 'workers-ai',
        inputCostPer1M: 0.06, outputCostPer1M: 0.40, cachedInputCostPer1M: 0.06,
        contextWindow: 131_072, maxOutput: 8_192,
    },
    // Documented rollback for inline if glm-4.7-flash's reasoning tokens make
    // tab latency unusable. FIM-trained, 8.4x more expensive per suggestion.
    '@cf/qwen/qwen2.5-coder-32b-instruct': {
        route: 'workers-ai',
        inputCostPer1M: 0.66, outputCostPer1M: 1.00, cachedInputCostPer1M: 0.66,
        contextWindow: 32_768, maxOutput: 8_192,
    },
    // Embeddings. Input-only; embeddings never generate.
    '@cf/baai/bge-small-en-v1.5': {
        route: 'workers-ai',
        inputCostPer1M: 0.02, outputCostPer1M: 0.00, cachedInputCostPer1M: 0.02,
        contextWindow: 512, maxOutput: 0,
    },
};

const DEFAULT_MAX_OUTPUT = 8192;
const DEFAULT_CONTEXT_WINDOW = 32768;

export function getMaxOutput(model: string): number {
    return MODEL_CATALOG[model]?.maxOutput ?? DEFAULT_MAX_OUTPUT;
}

export function getContextWindow(model: string): number {
    return MODEL_CATALOG[model]?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * Estimated list cost in USD for one request.
 *
 * `inputTokens` is the TOTAL prompt size and is inclusive of `cachedTokens`;
 * the fresh portion is `inputTokens - cachedTokens`. When a model defines
 * `longContext` and `inputTokens` exceeds its threshold, the entire request —
 * fresh, cached and output alike — bills at the long-context rates.
 *
 * An unknown model costs 0 (and is therefore never debited).
 */
export function estimateCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cachedTokens = 0,
): number {
    const info = MODEL_CATALOG[model];
    if (!info) return 0;

    const rates = info.longContext && inputTokens > info.longContext.thresholdTokens
        ? info.longContext
        : info;

    const cached = Math.min(Math.max(cachedTokens, 0), Math.max(inputTokens, 0));
    const fresh = Math.max(inputTokens, 0) - cached;

    return (fresh / 1_000_000) * rates.inputCostPer1M
         + (cached / 1_000_000) * rates.cachedInputCostPer1M
         + (Math.max(outputTokens, 0) / 1_000_000) * rates.outputCostPer1M;
}
