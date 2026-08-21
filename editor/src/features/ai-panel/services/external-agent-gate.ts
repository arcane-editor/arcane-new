/**
 * Pure gate for the external-agent (Claude Code) connection — every reason it
 * must NOT be selectable, in one testable place.
 *
 * Shape and discipline mirror `features/inline-suggest/services/gating.ts`:
 * collect a snapshot of the world, and let the FIRST failing reason pick the
 * copy, so an offline user never sees an upgrade upsell they can't act on.
 *
 * SINGLE SOURCE RULE: `PAID_PLANS` must track `isPaidPlan()` in
 * arcane-server/src/config/tiers.ts (a tier with `priceUsd > 0`: pro / proplus
 * / ultra). Unknown or missing plans coerce to locked, exactly like
 * `maxEntitledEffort(null) === 'low'` in `entitlement.ts`, so drift can only
 * ever WITHHOLD access (harmless), never grant it.
 *
 * Note on `on_hold`: a subscription in dunning keeps its paid `users.plan`
 * value (the billing webhook only records the status), so those users stay
 * entitled here. That is deliberate and matches every other paid gate.
 *
 * Why the gate is client-side: running Claude Code costs Arcane nothing — the
 * user pays Anthropic directly and no Arcane API call is involved — so there is
 * no server response to hang a 403 on. What keeps it honest is that `plan` is
 * never persisted: it is non-null only after a successful `/v1/usage` in THIS
 * app session.
 */

import type { AgentKind } from './types';

const PAID_PLANS = new Set(['pro', 'proplus', 'ultra']);

/** Snapshot of everything the gate reads. Collected by the caller. */
export interface ExternalAgentGate {
  loggedIn: boolean;
  online: boolean;
  /** `useAuthStore.plan` — null until a `/v1/usage` call has succeeded. */
  plan: string | null;
}

export type ExternalAgentStatus =
  | 'available'
  | 'signed-out'
  | 'offline'
  | 'plan-unknown'
  | 'upgrade-required';

/**
 * The single reason external agents are unavailable, or `'available'`.
 *
 * Order is load-bearing: `signed-out` outranks everything (a signed-out user
 * has no plan to check), and `offline` / `plan-unknown` outrank
 * `upgrade-required` so a paid user with no network is told to reconnect
 * rather than told to buy what they already own.
 */
export function externalAgentStatus(gate: ExternalAgentGate): ExternalAgentStatus {
  if (!gate.loggedIn) return 'signed-out';
  if (!gate.online) return 'offline';
  if (gate.plan === null) return 'plan-unknown';
  return PAID_PLANS.has(gate.plan) ? 'available' : 'upgrade-required';
}

export function canUseExternalAgents(gate: ExternalAgentGate): boolean {
  return externalAgentStatus(gate) === 'available';
}

/** Short label for the locked row in the agent picker. */
export const EXTERNAL_AGENT_STATUS_LABEL: Record<ExternalAgentStatus, string> = {
  available: '',
  'signed-out': 'Sign in',
  offline: 'Offline',
  'plan-unknown': 'Checking',
  'upgrade-required': 'Paid plans',
};

/** Tooltip / description copy. Never upsell on a status we cannot verify. */
export const EXTERNAL_AGENT_STATUS_TITLE: Record<ExternalAgentStatus, string> = {
  available: '',
  'signed-out': 'Sign in to your Arcane account to use external agents.',
  offline: 'Offline — reconnect to check your plan.',
  // Reached while `/v1/usage` is still in flight (plan is never persisted, so
  // every cold start passes through here) and after that call has failed. Both
  // mean "not confirmed yet", which is not the same as "you need to upgrade".
  'plan-unknown': "Confirming your plan — this clears once Arcane can reach the server.",
  'upgrade-required': 'Claude Code is available on paid plans.',
};

/** Only `upgrade-required` is actionable by buying something. */
export function showsUpgradeCta(status: ExternalAgentStatus): boolean {
  return status === 'upgrade-required';
}

/**
 * These two clear themselves the moment `/v1/usage` succeeds, so the fix is a
 * retry, not a purchase — worth offering inline rather than making the user
 * find Settings → Account.
 */
export function showsRetryCta(status: ExternalAgentStatus): boolean {
  return status === 'offline' || status === 'plan-unknown';
}

/**
 * Guard for the send path. Returns null when the send may proceed, or a
 * user-facing reason to refuse it.
 *
 * Re-evaluated per send rather than latched, so a plan that lapses mid-session
 * blocks the NEXT message while letting the running turn finish.
 */
export function refuseSendReason(
  agent: AgentKind,
  gate: ExternalAgentGate,
): string | null {
  if (agent === 'arcane') return null;
  const status = externalAgentStatus(gate);
  return status === 'available' ? null : EXTERNAL_AGENT_STATUS_TITLE[status];
}
