// Client-side mirror of the server's plan→tier entitlement, for decisions the
// editor makes BEFORE a request exists (auto-escalation must not pick a tier
// the send will 403 on).
//
// This is the OFFLINE FALLBACK only — the primary source of entitlement is
// `/v1/config` (see `stores/server-config.ts`'s `maxAllowedEffort`, which
// reads the server's per-tier `allowed` flags directly and only falls back
// to this ladder when no config has landed yet). `stores/server-config.ts`
// duplicates this exact mapping locally as `FALLBACK_PLAN_CEILING` rather
// than importing this function — a store can't import from inside a
// feature's `services/` dir (module-boundary rule) and this function is not
// re-exported through the `ai-panel` barrel, so this file and that one must
// be kept in sync by hand. `maxEntitledEffort` itself is exercised only by
// `entitlement.test.ts` now that `agent-service.ts` calls `maxAllowedEffort`
// directly; it stays exported as the canonical, independently-tested
// definition the duplicate must track.
//
// SINGLE SOURCE RULE: this must track `ALLOWED_TIERS` in
// arcane-server/src/config/tiers.ts — free/starter requests only 'low'; pro
// additionally requests 'mid'; max requests up to 'high'. Unknown or missing
// plans (including retired ids like proplus/ultra) coerce to 'low', exactly
// like the server's `isTierAllowed`, so drift can only ever WITHHOLD an
// escalation (harmless), never request a gated tier.

import type { Effort } from './types';

const PLAN_CEILING: Partial<Record<string, Effort>> = { pro: 'mid', max: 'high' };

/** Highest effort tier the account's plan may request. */
export function maxEntitledEffort(plan: string | null | undefined): Effort {
  return (plan && PLAN_CEILING[plan]) || 'low';
}
