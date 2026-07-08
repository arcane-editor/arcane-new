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
  /** Repeat-call guard suppressions this send (P3.2) — now reported to the server (P4). */
  loopGuardHits: number;
  /**
   * Whether repair-triggered tier escalation (P3.6, `turn-escalation.ts`) has
   * fired this send — now reported to the server (P4).
   */
  escalated: boolean;
  /** `unity_api_search` tool executions observed this send (P4, `recordTelemetryEvent`). */
  groundingToolCalls: number;
  /** `unity_api_search` "ok:false" (grounding UNAVAILABLE) results this send (P4, `api-search-tool.ts`). */
  groundingUnavailable: number;
  /**
   * Wall-clock latency (ms) of the most recently completed LLM request this
   * send (P4, `arcane-stream.ts`'s `usage` event handling). `null` until the
   * first request of the send completes — reported one request "behind" by
   * construction, since the telemetry snapshot for request N is built before
   * request N's own `usage` event arrives.
   */
  lastTurnLatencyMs: number | null;
}

const EMPTY_TELEMETRY: TurnTelemetry = {
  turnIndex: 0,
  toolErrorCount: 0,
  repairCount: 0,
  groundingLintHits: 0,
  loopGuardHits: 0,
  escalated: false,
  groundingToolCalls: 0,
  groundingUnavailable: 0,
  lastTurnLatencyMs: null,
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
 * Called once per genuine `unity_api_search` tool execution this send
 * (P4, inside `api-search-tool.ts`'s execute method). Counts only actual
 * executions that pass the repeat-call guard (guard is outermost), not event
 * emissions which include suppressed calls. Imported directly by `api-search-tool.ts`.
 */
export function recordGroundingToolCall(): void {
  current.groundingToolCalls++;
}

/**
 * Called once per `unity_api_search` "ok:false" (grounding UNAVAILABLE) result
 * this send — imported directly by `api-search-tool.ts` since that's the only
 * place both the lookup and search unavailable paths are visible (P4).
 */
export function recordGroundingUnavailable(): void {
  current.groundingUnavailable++;
}

/**
 * Records the most recently completed LLM request's wall-clock latency this
 * send (P4, `arcane-stream.ts`'s `usage` event handling). Overwrites on every
 * call — only the LATEST completed request's latency is kept.
 */
export function recordTurnLatency(latencyMs: number): void {
  current.lastTurnLatencyMs = latencyMs;
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
  if (event.type === 'tool_execution_end') {
    if (event.isError) {
      current.toolErrorCount++;
      return;
    }
  }
  if (event.type === 'message_end' && event.message.role === 'toolResult') {
    const c = event.message.content;
    const text = typeof c === 'string' ? c : '';
    if (REPAIR_MARKERS.some((m) => text.includes(m)) && !text.includes('] Clean')) {
      current.repairCount++;
    }
  }
}
