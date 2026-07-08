/**
 * Per-model CLI presets for `run-eval.ts`'s `--preset` flag.
 *
 * Mirrors README.md's two documented invocation variants (direct Cloudflare
 * OpenAI-compat endpoint = "Variant A"; local `wrangler dev` arcane-server
 * routing = "Variant B") plus the exact model ids `arcane-server`'s
 * `INTENSITY_CONFIG` (`arcane-server/src/config/plans.ts`) maps each
 * reasoning level to — so `--preset cf-mid` runs the same model production's
 * `mid` tier actually picks, not a hand-copied id that can drift out of sync.
 *
 * Labels mirror `results/baselines/` naming (`cf-mid-kimi-k2.7`,
 * `cf-high-glm-5.2` are the two committed baselines as of 2026-07-08) so a
 * `--preset` run's result JSON/report slots in next to them without a
 * rename.
 */

export interface Preset {
  /** Lazy: `cf-*` presets need `CF_ACCOUNT_ID` from the environment, which
   * isn't available at module-load time in every context (e.g. tests). */
  baseUrl: (env: NodeJS.ProcessEnv) => string | undefined;
  apiKeyEnv: string;
  model: string;
  reasoningLevel?: string;
  label: string;
  description: string;
}

const cloudflareBaseUrl = (env: NodeJS.ProcessEnv): string | undefined =>
  env.CF_ACCOUNT_ID
    ? `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/v1`
    : undefined;

export const PRESETS: Record<string, Preset> = {
  'cf-low': {
    baseUrl: cloudflareBaseUrl,
    apiKeyEnv: 'CF_API_TOKEN',
    // INTENSITY_CONFIG.low (arcane-server/src/config/plans.ts)
    model: '@cf/qwen/qwen2.5-coder-32b-instruct',
    label: 'cf-low-qwen2.5-coder',
    description: 'Direct Cloudflare endpoint, low reasoning tier (needs CF_ACCOUNT_ID + CF_API_TOKEN)',
  },
  'cf-mid': {
    baseUrl: cloudflareBaseUrl,
    apiKeyEnv: 'CF_API_TOKEN',
    // INTENSITY_CONFIG.mid — today's default tier.
    model: '@cf/moonshotai/kimi-k2.7-code',
    label: 'cf-mid-kimi-k2.7',
    description: 'Direct Cloudflare endpoint, mid reasoning tier (needs CF_ACCOUNT_ID + CF_API_TOKEN)',
  },
  'cf-high': {
    baseUrl: cloudflareBaseUrl,
    apiKeyEnv: 'CF_API_TOKEN',
    // INTENSITY_CONFIG.high.
    model: '@cf/zai-org/glm-5.2',
    label: 'cf-high-glm-5.2',
    description: 'Direct Cloudflare endpoint, high reasoning tier (needs CF_ACCOUNT_ID + CF_API_TOKEN)',
  },
  'server-mid': {
    // Variant B: arcane-server picks the model server-side from
    // `metadata.reasoningLevel` — `model` here is a required CLI flag /
    // label only, never read by the server (see run-eval.ts's file header).
    baseUrl: () => 'http://localhost:8787/v1',
    apiKeyEnv: 'DEV_JWT',
    model: 'unused',
    reasoningLevel: 'mid',
    label: 'server-mid',
    description: 'Local `wrangler dev` arcane-server routing, mid reasoning level (needs DEV_JWT; see README Variant B)',
  },
};

export interface ExplicitEvalFlags {
  baseUrl?: string;
  apiKeyEnv?: string;
  model?: string;
  reasoningLevel?: string;
  label?: string;
}

/**
 * Merge an optional `--preset` onto explicit CLI flags. Explicit flags
 * always win — a preset only fills in fields the caller didn't already set,
 * so `--preset cf-mid --model my-fork-of-kimi` still uses the caller's model.
 */
export function resolvePreset(
  presetName: string | undefined,
  explicit: ExplicitEvalFlags,
  env: NodeJS.ProcessEnv,
): ExplicitEvalFlags {
  if (!presetName) return explicit;
  const preset = PRESETS[presetName];
  if (!preset) {
    throw new Error(`Unknown --preset "${presetName}". Valid presets: ${Object.keys(PRESETS).join(', ')}`);
  }
  return {
    baseUrl: explicit.baseUrl ?? preset.baseUrl(env),
    apiKeyEnv: explicit.apiKeyEnv ?? preset.apiKeyEnv,
    model: explicit.model ?? preset.model,
    reasoningLevel: explicit.reasoningLevel ?? preset.reasoningLevel,
    label: explicit.label ?? preset.label,
  };
}
