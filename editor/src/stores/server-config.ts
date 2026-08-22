/**
 * Server-published plan/tier config (`GET /v1/config`) — the runtime source of
 * truth for what the account's plan is entitled to. Populated best-effort
 * alongside `stores/auth.ts`'s `refreshUsage()` (login, session-restore,
 * Account mount, stream 402s) and cleared on sign-out.
 *
 * SINGLE SOURCE RULE: the shape here is a cross-repo contract, already live —
 * `arcane-server/src/routes/config.ts` is the source of truth for the
 * response body. Every pure accessor below is config-first with a hardcoded
 * offline fallback, so the editor keeps working (conservatively) the instant
 * before the first successful `/v1/config` round-trip, and after one fails.
 *
 * Import discipline: this store is imported BY
 * `features/ai-panel/services/agent-service.ts` (for the context-window and
 * escalation-ceiling accessors), which is itself re-exported through the
 * `features/ai-panel` barrel. A static VALUE import of anything from that
 * barrel — or a deep import into one of its internal files, which the
 * module-boundary check forbids anyway — back into this file would either
 * create an import cycle or drag this store's tests through the entire
 * agent-service dependency graph (Tauri-coupled tool operations, the vendor
 * agent loop, etc.) just to read a plan→effort ladder or a fallback context
 * window. `stores/checkpoints.ts`'s header documents the same constraint and
 * the same fix: the few small fallback constants this file needs from
 * `entitlement.ts` / `types.ts` are duplicated here (never imported), each
 * commented with what it must track. A type-only import of `Effort` is safe
 * (erased at compile time, no runtime edge) and is used below.
 */

import { create } from 'zustand';
import { ARCANE_API_URL } from '../config/api';
import { useAuthStore } from './auth';
import type { Effort } from '../features/ai-panel';

export interface ServerTierConfig {
  id: Effort;
  label: string;
  description: string;
  allowed: boolean;
  hasPreplanning: boolean;
  contextWindow: number;
  pricingCliffTokens: number | null;
}

export interface ServerConfig {
  plan: string;
  planLabel: string;
  features: { inline: boolean; acp: boolean; topups: boolean };
  tiers: ServerTierConfig[];
}

interface ServerConfigState {
  config: ServerConfig | null;
  refresh: () => Promise<void>;
  clear: () => void;
}

interface ServerConfigStoreConfig {
  fetchImpl?: typeof fetch;
  getToken?: () => string | null;
  baseUrl?: string;
}

const EXPECTED_TIER_IDS: readonly Effort[] = ['low', 'mid', 'high'];

/** Minimal shape validation — just enough to reject a malformed/truncated
 *  body without pinning to every field the server happens to send today. */
function isValidServerConfig(body: unknown): body is ServerConfig {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  if (typeof b.plan !== 'string' || typeof b.planLabel !== 'string') return false;
  if (!b.features || typeof b.features !== 'object') return false;
  const f = b.features as Record<string, unknown>;
  if (typeof f.inline !== 'boolean' || typeof f.acp !== 'boolean' || typeof f.topups !== 'boolean') {
    return false;
  }
  if (!Array.isArray(b.tiers) || b.tiers.length !== 3) return false;
  const ids = (b.tiers as Array<Record<string, unknown>>).map((t) => t.id);
  return EXPECTED_TIER_IDS.every((id) => ids.includes(id));
}

/** Factory (follows `createInlineClient`'s pattern) so tests can inject a
 *  fake fetch + token without touching the real auth store or network. */
export function createServerConfigStore(cfg: ServerConfigStoreConfig = {}) {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const getToken = cfg.getToken ?? (() => useAuthStore.getState().token);
  const baseUrl = cfg.baseUrl ?? ARCANE_API_URL;

  return create<ServerConfigState>((set) => ({
    config: null,

    refresh: async () => {
      const token = getToken();
      if (!token) return; // Nothing to authenticate with — keep whatever we had.
      try {
        const res = await fetchImpl(`${baseUrl}/v1/config`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return; // Non-2xx — transient or auth issue; keep previous.
        const body = await res.json().catch(() => null);
        if (!isValidServerConfig(body)) return; // Malformed — keep previous.
        set({ config: body });
      } catch {
        // Network error — keep previous config; never blank a known plan.
      }
    },

    clear: () => set({ config: null }),
  }));
}

/** Production store (real fetch, auth-store token, configured API base). */
export const useServerConfigStore = createServerConfigStore();

// ---------------------------------------------------------------------------
// Pure accessors — config-first, hardcoded fallback. Every one takes the
// config as a plain argument (not read from the store) so callers can pass a
// snapshot and stay testable without touching Zustand.
// ---------------------------------------------------------------------------

const EFFORT_LADDER: readonly Effort[] = ['low', 'mid', 'high'];
const EFFORT_RANK: Record<Effort, number> = { low: 0, mid: 1, high: 2 };

/** Mirrors `TIER_CONTEXT_WINDOWS` in `features/ai-panel/services/types.ts`
 *  (see header for why this is a duplicate, not an import). Update both
 *  together. */
const FALLBACK_CONTEXT_WINDOW: Record<Effort, number> = {
  low: 131_072,
  mid: 131_072,
  high: 131_072,
};

/** Mirrors `maxEntitledEffort` in `features/ai-panel/services/entitlement.ts`
 *  (see header for why this is a duplicate, not an import). Update both
 *  together: free/starter/unknown → low, pro → mid, max → high. */
const FALLBACK_PLAN_CEILING: Partial<Record<string, Effort>> = { pro: 'mid', max: 'high' };
function fallbackMaxEntitledEffort(plan: string | null | undefined): Effort {
  return (plan && FALLBACK_PLAN_CEILING[plan]) || 'low';
}

/** Compaction budget for a tier: the server's per-tier minimum usable window
 *  across that tier's role models, or the offline fallback. */
export function effectiveContextWindow(config: ServerConfig | null, effort: Effort): number {
  return config?.tiers.find((t) => t.id === effort)?.contextWindow ?? FALLBACK_CONTEXT_WINDOW[effort];
}

/** Every tier the account's plan may currently request. */
export function allowedEfforts(
  config: ServerConfig | null,
  plan: string | null | undefined,
): Effort[] {
  if (config) {
    return config.tiers.filter((t) => t.allowed).map((t) => t.id);
  }
  const ceiling = fallbackMaxEntitledEffort(plan);
  return EFFORT_LADDER.slice(0, EFFORT_RANK[ceiling] + 1);
}

/** Highest tier the account's plan may currently request. */
export function maxAllowedEffort(
  config: ServerConfig | null,
  plan: string | null | undefined,
): Effort {
  let best: Effort = 'low';
  for (const e of allowedEfforts(config, plan)) {
    if (EFFORT_RANK[e] > EFFORT_RANK[best]) best = e;
  }
  return best;
}

/** Whether a tier runs its preplanning pass. */
export function shouldPreplanTier(config: ServerConfig | null, effort: Effort): boolean {
  return config?.tiers.find((t) => t.id === effort)?.hasPreplanning ?? effort !== 'low';
}

/** Whether inline completions are available. Unknown (no config yet) ⇒ true:
 *  the server 403s an actually-disabled account, and a startup race must not
 *  blank a paid user's completions before the first `/v1/config` lands. */
export function inlineAllowed(config: ServerConfig | null): boolean {
  return config?.features.inline ?? true;
}

/** Whether external agents (ACP) are available. Unknown (no config yet) ⇒
 *  null — the ACP gate fails CLOSED on unknown, matching its current posture
 *  (see `external-agent-gate.ts`). */
export function acpAllowed(config: ServerConfig | null): boolean | null {
  return config?.features.acp ?? null;
}
