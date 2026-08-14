/**
 * Repair-triggered tier escalation (P3.6). When the agent needs repeated
 * compile/analyzer/LSP repairs mid-send, it's cheaper to finish the send on a
 * stronger model than to keep looping on a weak one. The server resolves the
 * model PER REQUEST from `metadata.reasoningLevel`
 * (`arcane-server/src/routes/chat.ts` `resolveModelFromRequest`), so
 * mid-send escalation Just Works — the next request simply carries a higher
 * level; `arcane-stream.ts` itself never changes.
 *
 * Implemented as a `StreamFn` decorator — the same shape `turn-governor.ts`
 * uses to bound the vendor agent loop from outside — rather than folded
 * into that module. Bounding the call count (and stripping tools at the cap)
 * and choosing which reasoning tier a request carries are independent
 * concerns with their own config, reset, and notice; a dedicated wrapper
 * keeps each concern's tests focused. Compose this INSIDE `withTurnGovernor`
 * (`withTurnGovernor(withTurnEscalation(arcaneStream))`, see
 * `agent-service.ts`) so the governor's own per-effort call-cap lookup keeps
 * reading the send's ORIGINAL effort, unaffected by escalation — only the
 * request actually sent to `arcaneStream` carries the bumped tier.
 *
 * Per-send state (the escalated tier, once triggered) is module-level,
 * reset via `resetTurnEscalation()` — the same pattern `resetTurnGovernor` /
 * `resetTurnTelemetry` use. An aborted send never persists its escalation:
 * `agent-service.ts`'s `sendMessage` resets this at the START of every send
 * (mirroring the other per-send resets there), so a cancelled send's
 * leftover escalated state never survives into the next one.
 *
 * Effort resolution: same as `turn-governor.ts` — `StreamOptions.reasoning`
 * carries the effort the agent was configured with for this send, threaded
 * unchanged through every internal loop call, so this module reads it
 * directly instead of needing an independently-synchronized copy.
 */

import type { Context, StreamFn, StreamOptions } from './vendor/types';
import type { Effort } from './types';
import { getRepairCount, recordEscalation } from './turn-telemetry';
import { useSettingsStore } from '../../../stores/settings';

const KNOWN_EFFORTS: readonly Effort[] = ['low', 'mid', 'high'];

/** Repair count (turn-telemetry's `repairCount`, already counting the gate sentinels) at which a send escalates. */
const ESCALATION_THRESHOLD = 2;

/** low -> mid, mid -> high. `high` has no stronger tier to escalate to (no-op). */
const NEXT_TIER: Partial<Record<Effort, Effort>> = { low: 'mid', mid: 'high' };

export interface TurnEscalationConfig {
  /** Defaults to reading the `ai.escalation.enabled` setting (default on). */
  isEnabled?: () => boolean;
  /** Injectable for tests; defaults to `turn-telemetry.ts`'s live repair count. */
  getRepairCount?: () => number;
  /**
   * Fires once per send when the tier is bumped. Defaults to pushing an
   * ai-store notice (dynamic import — see the module header on
   * `turn-governor.ts`'s `defaultOnCapReached` for why: keeps this module
   * loadable outside a browser/DOM environment even though nothing here
   * currently requires that).
   */
  onEscalate?: (tier: Effort) => void;
}

let escalatedTier: Effort | null = null;

/** Reset the per-send escalated tier. Call once per user send (mirrors `resetTurnGovernor`). */
export function resetTurnEscalation(): void {
  escalatedTier = null;
}

/** Whether this send has escalated. */
export function isEscalated(): boolean {
  return escalatedTier !== null;
}

function normalizeEffort(reasoning: string | undefined): Effort {
  return (KNOWN_EFFORTS as readonly string[]).includes(reasoning ?? '')
    ? (reasoning as Effort)
    : 'mid';
}

function defaultIsEnabled(): boolean {
  return useSettingsStore.getState().getSetting('ai.escalation.enabled') !== false;
}

function defaultOnEscalate(tier: Effort): void {
  import('../../../stores/ai')
    .then(({ useAiStore }) => {
      useAiStore.getState().addSystemMessage(`Escalated to ${tier} after repeated compile repairs`);
    })
    .catch(() => {
      // Best-effort notice only — never let this break the actual send.
    });
}

/**
 * Pure escalation decision: given the send's configured effort and the
 * current repair count, returns the effort that should actually be used for
 * this request — triggering (and latching, for the rest of the send) the
 * bump the first time `repairCount` crosses the threshold with a stronger
 * tier available. Once latched, keeps returning the SAME escalated tier on
 * every later call regardless of `repairCount`/`effort` — escalation only
 * ever happens once per send. Exported mainly for direct testing of the
 * state machine; `withTurnEscalation` is the wired call site.
 */
export function getEffectiveReasoningLevel(
  effort: Effort,
  repairCount: number,
  onEscalate: (tier: Effort) => void = defaultOnEscalate,
): Effort {
  if (escalatedTier) return escalatedTier;

  const nextTier = NEXT_TIER[effort];
  if (repairCount >= ESCALATION_THRESHOLD && nextTier) {
    escalatedTier = nextTier;
    onEscalate(nextTier);
    return nextTier;
  }

  return effort;
}

/**
 * Wrap a `StreamFn` with repair-triggered tier escalation. Composed ONCE —
 * `withTurnGovernor(withTurnEscalation(arcaneStream))` at Agent construction
 * in `agent-service.ts` — since per-send state lives at module scope (see
 * `resetTurnEscalation`).
 */
export function withTurnEscalation(
  streamFn: StreamFn,
  getConfig: () => TurnEscalationConfig = () => ({}),
): StreamFn {
  return (context: Context, options: StreamOptions) => {
    const config = getConfig();
    if ((config.isEnabled ?? defaultIsEnabled)() === false) {
      return streamFn(context, options);
    }

    const effort = normalizeEffort(options.reasoning);
    const repairCount = (config.getRepairCount ?? getRepairCount)();
    const effective = getEffectiveReasoningLevel(effort, repairCount, config.onEscalate ?? defaultOnEscalate);

    if (effective === effort) {
      return streamFn(context, options);
    }

    // Latch onto turn-telemetry too, so THIS and every later request's
    // telemetry snapshot (sent to the server as `metadata.telemetry`) carries
    // `escalated: true` — idempotent, safe to call again on later requests.
    recordEscalation();
    return streamFn(context, { ...options, reasoning: effective });
  };
}
