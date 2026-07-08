/**
 * Per-user-send agent telemetry, reported to the server in request metadata
 * (request_logs columns) — turns per task, tool failures, repair loops.
 * Reset at the start of every user send; turnIndex increments per LLM request.
 */

import type { AgentEvent } from './vendor/types';

interface TurnTelemetry {
  turnIndex: number;
  toolErrorCount: number;
  repairCount: number;
  /** Ask-mode grounding-linter revise cycles fired this send (P2.2) — 0 or 1. */
  groundingLintHits: number;
  /** Repeat-call guard suppressions this send (P3.2) — client-side only; server column is P4. */
  loopGuardHits: number;
  /**
   * Whether repair-triggered tier escalation (P3.6, `turn-escalation.ts`) has
   * fired this send — client-side only; server column is P4.
   */
  escalated: boolean;
}

const EMPTY_TELEMETRY: TurnTelemetry = {
  turnIndex: 0,
  toolErrorCount: 0,
  repairCount: 0,
  groundingLintHits: 0,
  loopGuardHits: 0,
  escalated: false,
};

let current: TurnTelemetry = { ...EMPTY_TELEMETRY };

export function resetTurnTelemetry(): void {
  current = { ...EMPTY_TELEMETRY };
}

/** Called once when the grounding linter fires a revise turn for this send (P2.2). */
export function recordGroundingLintHit(): void {
  current.groundingLintHits++;
}

/** Called once per repeat-call-guard suppression this send (P3.2, `tool-guards.ts`). */
export function recordLoopGuardHit(): void {
  current.loopGuardHits++;
}

/**
 * Read-only peek at the current repair count — consulted by
 * `turn-escalation.ts` at request-build time. Unlike `nextTurnTelemetry`,
 * this does NOT increment `turnIndex`, since checking whether to escalate
 * isn't itself a new outgoing request.
 */
export function getRepairCount(): number {
  return current.repairCount;
}

/**
 * Marks this send as escalated (P3.6, `turn-escalation.ts`) once the tier
 * has been bumped, so every subsequent request's telemetry snapshot (and the
 * request metadata sent to the server) carries it. Idempotent — safe to call
 * on every request once escalated, not just the triggering one.
 */
export function recordEscalation(): void {
  current.escalated = true;
}

/** Called once per outgoing LLM request; returns the snapshot to send. */
export function nextTurnTelemetry(): TurnTelemetry {
  current.turnIndex++;
  return { ...current };
}

const REPAIR_MARKERS = ['[Unity compile]', '[Unity analyzers]', '[C# language server]'];

export function recordTelemetryEvent(event: AgentEvent): void {
  if (event.type === 'tool_execution_end' && event.isError) {
    current.toolErrorCount++;
    return;
  }
  if (event.type === 'message_end' && event.message.role === 'toolResult') {
    const c = event.message.content;
    const text = typeof c === 'string' ? c : '';
    if (REPAIR_MARKERS.some((m) => text.includes(m)) && !text.includes('] Clean')) {
      current.repairCount++;
    }
  }
}
