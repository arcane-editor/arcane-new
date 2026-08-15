/**
 * Send-boundary tier escalation — the cache-aware replacement for the old
 * mid-send `turn-escalation.ts` decorator.
 *
 * Why send boundaries: provider prompt caches are per-model, so switching
 * models MID-send silently re-billed the entire conversation history at
 * fresh-input rates on the very sends that were already burning repair
 * turns. Escalating between sends pays that cold-cache cost once, at a
 * natural boundary, and then STAYS on the stronger tier for the rest of the
 * conversation (latching) so the cache re-warms and holds.
 *
 * Decision inputs: the PREVIOUS send's final repair count (compile/analyzer/
 * LSP gate sentinels, `turn-telemetry.ts`) and the user's requested effort.
 * A user manually raising effort above the latched tier clears the latch —
 * their choice supersedes ours.
 *
 * Per-conversation state is module-level, keyed by ai-store sessionId, and
 * cleared via `resetSendEscalation()` from the same dispose/reset paths that
 * clear the frozen prompt decoration.
 */

import type { Effort } from './types';

/** Previous-send repair count at which the next send escalates. */
export const SEND_ESCALATION_THRESHOLD = 2;

const NEXT_TIER: Partial<Record<Effort, Effort>> = { low: 'mid', mid: 'high' };

const TIER_RANK: Record<Effort, number> = { low: 0, mid: 1, high: 2 };

/** sessionId → latched tier for the rest of that conversation. */
const latched = new Map<string, Effort>();

export interface SendEscalationResult {
  effort: Effort;
  /** True only on the send where the bump first happens (drives the notice). */
  escalatedNow: boolean;
}

export function resolveSendEffort(
  sessionId: string | null | undefined,
  requested: Effort,
  prevRepairCount: number,
  isEnabled: () => boolean,
): SendEscalationResult {
  if (!isEnabled()) return { effort: requested, escalatedNow: false };
  if (!sessionId) return { effort: requested, escalatedNow: false };

  const existing = latched.get(sessionId);
  if (existing) {
    // The user manually selecting a tier at or above the latch supersedes it.
    if (TIER_RANK[requested] >= TIER_RANK[existing]) {
      latched.delete(sessionId);
      return { effort: requested, escalatedNow: false };
    }
    return { effort: existing, escalatedNow: false };
  }

  const next = NEXT_TIER[requested];
  if (prevRepairCount >= SEND_ESCALATION_THRESHOLD && next) {
    latched.set(sessionId, next);
    return { effort: next, escalatedNow: true };
  }

  return { effort: requested, escalatedNow: false };
}

/** Clear all conversation latches (New Chat / workspace switch / dispose). */
export function resetSendEscalation(): void {
  latched.clear();
}
