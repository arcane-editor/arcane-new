// Client-side mirror of the server's plan→tier entitlement, for decisions the
// editor makes BEFORE a request exists (auto-escalation must not pick a tier
// the send will 403 on).
//
// SINGLE SOURCE RULE: this must track `ALLOWED_TIERS` in
// arcane-server/src/config/tiers.ts — free requests only 'low'; every paid
// plan (pro/proplus/ultra) requests up to 'high'. Unknown or missing plans
// coerce to free, exactly like the server's `isTierAllowed`, so drift can
// only ever WITHHOLD an escalation (harmless), never request a gated tier.

import type { Effort } from './types';

const PAID_PLANS = new Set(['pro', 'proplus', 'ultra']);

/** Highest effort tier the account's plan may request. */
export function maxEntitledEffort(plan: string | null | undefined): Effort {
  return plan && PAID_PLANS.has(plan) ? 'high' : 'low';
}
