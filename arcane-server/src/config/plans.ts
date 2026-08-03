// ─── Intensity levels (model routing per reasoning level) ────
//
// THE single source of truth for which model each reasoning level maps to.
// Model choice happens here on the backend — the editor only ever sends an
// abstract `reasoningLevel` (low|mid|high|super), never a concrete model id.
//
// low/high route to EXTERNAL providers (MiniMax, Moonshot) through the AI
// Gateway's /compat endpoint using custom-provider slugs — see
// services/llm-router.ts. mid + inline stay on the Workers AI binding.
// The "FROZEN — CF only" constraint was lifted by the 2026-08-03 design.
// ⚠️ Verify the exact upstream model-id strings when registering the custom
// providers (see the manual-setup runbook); they are config, not code.

export type Intensity = 'low' | 'mid' | 'high' | 'super';

export interface IntensityConfig {
    model: string;
    label: string;
}

export const INTENSITY_CONFIG: Record<Intensity, IntensityConfig> = {
    low:   { model: 'custom-minimax/MiniMax-M3', label: 'Low' },
    mid:   { model: '@cf/zai-org/glm-5.2',       label: 'Mid' },
    high:  { model: 'custom-moonshot/kimi-k3',   label: 'High' },
    super: { model: 'custom-moonshot/kimi-k3',   label: 'Extra High' }, // alias of high until a dedicated model is chosen
};

/** Model for inline (tab) completions — cheap, fast, FIM-capable, CF binding. */
export const INLINE_MODEL = '@cf/qwen/qwen2.5-coder-32b-instruct';

export function getIntensityConfig(level: string): IntensityConfig | undefined {
    return INTENSITY_CONFIG[level as Intensity];
}
