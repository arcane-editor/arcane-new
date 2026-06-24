// ─── Intensity levels (model routing per reasoning level) ────
//
// THE single source of truth for which model each reasoning level maps to.
// Model choice happens here on the backend — the editor only ever sends an
// abstract `reasoningLevel` (low|mid|high|super), never a concrete model id.
//
// All ids are Cloudflare Workers AI catalog models, reached through the
// AI Gateway (see services/llm-router.ts). No external provider keys.
//
// ⚠️ Verify these exact ids against the live catalog: `wrangler ai models`.

export type Intensity = 'low' | 'mid' | 'high' | 'super';

export interface IntensityConfig {
    model: string;
    label: string;
}

export const INTENSITY_CONFIG: Record<Intensity, IntensityConfig> = {
    low:   { model: '@cf/qwen/qwen2.5-coder-32b-instruct', label: 'Low' },
    mid:   { model: '@cf/moonshotai/kimi-k2.7-code',       label: 'Mid' },
    high:  { model: '@cf/zai-org/glm-5.2',                 label: 'High' },
    super: { model: '@cf/zai-org/glm-5.2',                 label: 'Extra High' }, // placeholder — own implementation later
};

export function getIntensityConfig(level: string): IntensityConfig | undefined {
    return INTENSITY_CONFIG[level as Intensity];
}
