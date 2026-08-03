// Workers AI model catalog — used for (a) the soft hourly USD spend cap and
// (b) clamping max output tokens per model.
//
// Cloudflare bills Workers AI in "neurons", not per-token USD. The USD figures
// below are APPROXIMATE blended rates (derived from published Workers AI
// pricing) so the existing cost_usd / hourly-cap machinery keeps working with
// no DB migration. The $1/hr cap is therefore a *soft* limit, not exact
// accounting. Adjust these as real per-model neuron rates are confirmed.

interface ModelInfo {
    provider: 'workers-ai' | 'minimax' | 'moonshot';
    inputCostPer1M: number;
    outputCostPer1M: number;
    contextWindow: number;
    maxOutput: number;
    tier: 'fast' | 'standard' | 'premium';
}

export const MODEL_CATALOG: Record<string, ModelInfo> = {
    // low — MiniMax M3 via AI Gateway custom provider. ⚠️ Prices below are
    // provisional — confirm against MiniMax's pricing page during the manual
    // setup (runbook) and adjust; wrong prices skew credit debits.
    'custom-minimax/MiniMax-M3':  { provider: 'minimax',  inputCostPer1M: 0.40, outputCostPer1M: 2.20, contextWindow: 200000, maxOutput: 32000, tier: 'fast' },
    // high/super — Kimi 3 via AI Gateway custom provider. Same price caveat.
    'custom-moonshot/kimi-k3':    { provider: 'moonshot', inputCostPer1M: 0.60, outputCostPer1M: 2.50, contextWindow: 256000, maxOutput: 32000, tier: 'premium' },
    // inline — Qwen2.5-Coder 32B (native Workers AI, code-specialized)
    '@cf/qwen/qwen2.5-coder-32b-instruct': { provider: 'workers-ai', inputCostPer1M: 0.30, outputCostPer1M: 1.20, contextWindow: 32768, maxOutput: 8192, tier: 'fast' },
    // mid — GLM-5.2 (Zhipu / Z.AI)
    '@cf/zai-org/glm-5.2':                 { provider: 'workers-ai', inputCostPer1M: 0.60, outputCostPer1M: 2.20, contextWindow: 200000, maxOutput: 32000, tier: 'premium' },
    // legacy/fallback — Kimi K2.7 Code (Moonshot). Retained for backward compatibility.
    '@cf/moonshotai/kimi-k2.7-code':       { provider: 'workers-ai', inputCostPer1M: 0.60, outputCostPer1M: 2.40, contextWindow: 256000, maxOutput: 32000, tier: 'standard' },
    // embeddings — BGE Small (384-dim). Input-only cost; embeddings never
    // generate, so outputCostPer1M/maxOutput are 0. Rate is a real published
    // Workers AI figure: 1841 neurons/1M × $0.011/1000 ≈ $0.020/1M. Without this
    // entry estimateCost() returns 0 for every embeddings/unity-search call,
    // silently under-counting real neuron spend.
    '@cf/baai/bge-small-en-v1.5':          { provider: 'workers-ai', inputCostPer1M: 0.02, outputCostPer1M: 0.00, contextWindow: 512, maxOutput: 0, tier: 'fast' },
};

// Fallback used when a model isn't in the catalog (e.g. an id that was renamed
// upstream) so output isn't clamped to 0.
const DEFAULT_MAX_OUTPUT = 8192;

export function getMaxOutput(model: string): number {
    return MODEL_CATALOG[model]?.maxOutput ?? DEFAULT_MAX_OUTPUT;
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
    const info = MODEL_CATALOG[model];
    if (!info) return 0;
    return (inputTokens / 1_000_000) * info.inputCostPer1M
         + (outputTokens / 1_000_000) * info.outputCostPer1M;
}
