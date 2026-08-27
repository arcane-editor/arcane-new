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
import { API_URL } from '../config/api';
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
  const baseUrl = cfg.baseUrl ?? API_URL;

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
  low: 1_048_576,
  mid: 500_000,
  high: 400_000,
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

/**
 * STALE-CONFIG GUARD (entitlement-shaped accessors only — `allowedEfforts`,
 * `maxAllowedEffort`, `inlineAllowed`, `acpAllowed`): `refresh()` keeps the
 * previous config on any failure and never re-nulls it, so a config fetched
 * under a HIGHER plan can outlive a downgrade — e.g. `refreshUsage()` sets
 * `plan: 'free'` from `/v1/usage` but the fire-and-forget `/v1/config`
 * refresh that follows it fails, leaving a stale `pro`-tier config still
 * marking `mid` `allowed: true`. Trusting that config would silently
 * re-authorize a tier the account no longer has, including letting
 * `resolveSendEffort`'s escalation latch climb (and stay latched) past the
 * account's real ceiling — exactly the bricked-session failure the ceiling
 * exists to prevent.
 *
 * So every one of these accessors treats `config` as current only when its
 * own `plan` field agrees with the caller's independently-sourced `plan`
 * argument (from `useAuthStore`). A known, mismatched plan makes the config
 * UNKNOWN for this call (fallback path). A `null`/`undefined` plan (no
 * `/v1/usage` response yet) has nothing to contradict the config with, so a
 * present config is still trusted — it is the best signal available.
 *
 * `shouldPreplanTier` deliberately does NOT take this guard (or a `plan` at
 * all): preplanning is a per-tier product choice, not an entitlement, so a
 * stale config can't leak extra access through it.
 */
function isConfigCurrent(config: ServerConfig | null, plan: string | null | undefined): config is ServerConfig {
  return config !== null && (plan == null || config.plan === plan);
}

/** Every tier the account's plan may currently request. */
export function allowedEfforts(
  config: ServerConfig | null,
  plan: string | null | undefined,
): Effort[] {
  if (isConfigCurrent(config, plan)) {
    return config.tiers.filter((t) => t.allowed).map((t) => t.id);
  }
  const ceiling = fallbackMaxEntitledEffort(plan);
  return EFFORT_LADDER.slice(0, EFFORT_RANK[ceiling] + 1);
}

/**
 * Highest tier the account's plan may currently request.
 *
 * The wire contract guarantees every plan's tier list includes `low`
 * (`allowed: true` on at least the `low` row — see the brief's example and
 * the server's `ALLOWED_TIERS`), and the offline fallback ladder always
 * includes `low` too, so `allowedEfforts` is never actually empty in
 * practice. `best` still starts at `'low'` defensively in case that ever
 * stops holding — this never returns something LOWER than the wire/fallback
 * guarantee, only degrades gracefully if the guarantee is ever violated.
 */
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

/** Whether a tier runs its preplanning pass. Config-first, unconditionally —
 *  see the STALE-CONFIG GUARD note above for why this one is exempt. */
export function shouldPreplanTier(config: ServerConfig | null, effort: Effort): boolean {
  return config?.tiers.find((t) => t.id === effort)?.hasPreplanning ?? effort !== 'low';
}

/** Whether inline completions are available. Unknown (no current config for
 *  this plan) ⇒ true: the server 403s an actually-disabled account, and a
 *  startup race (or a stale config from a since-downgraded plan) must not
 *  blank a user's completions. */
export function inlineAllowed(config: ServerConfig | null, plan: string | null | undefined): boolean {
  return isConfigCurrent(config, plan) ? config.features.inline : true;
}

/** Whether external agents (ACP) are available. Unknown (no current config
 *  for this plan) ⇒ null — the ACP gate fails CLOSED on unknown, matching
 *  its current posture (see `external-agent-gate.ts`). */
export function acpAllowed(config: ServerConfig | null, plan: string | null | undefined): boolean | null {
  return isConfigCurrent(config, plan) ? config.features.acp : null;
}
