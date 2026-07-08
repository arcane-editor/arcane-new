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
}

let current: TurnTelemetry = { turnIndex: 0, toolErrorCount: 0, repairCount: 0, groundingLintHits: 0 };

export function resetTurnTelemetry(): void {
  current = { turnIndex: 0, toolErrorCount: 0, repairCount: 0, groundingLintHits: 0 };
}

/** Called once when the grounding linter fires a revise turn for this send (P2.2). */
export function recordGroundingLintHit(): void {
  current.groundingLintHits++;
}

/** Called once per outgoing LLM request; returns the snapshot to send. */
export function nextTurnTelemetry(): TurnTelemetry {
  current.turnIndex++;
  return { ...current };
}

const REPAIR_MARKERS = ['[Unity compile]', '[Unity analyzers]'];

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
