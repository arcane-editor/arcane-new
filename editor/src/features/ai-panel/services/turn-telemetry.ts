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
   * Whether send-boundary tier escalation (`send-escalation.ts`) applies to
   * this send — reported to the server (P4).
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

/**
 * Cheap harness nudge (T9, Part 4) — mutating tool calls (`write`/`edit`/
 * `bash`) and `todo_update` calls observed THIS send. Local-only: unlike
 * `TurnTelemetry` above, this is never read by `nextTurnTelemetry()` and
 * never reaches `metadata.telemetry` sent to the server — it only drives the
 * client-side prompt reminder in `agent-service.ts`.
 */
interface NudgeCounts {
  mutatingCalls: number;
  todoUpdateCalls: number;
}

const EMPTY_NUDGE_COUNTS: NudgeCounts = { mutatingCalls: 0, todoUpdateCalls: 0 };
const MUTATING_TOOL_NAMES = new Set(['write', 'edit', 'bash']);

let nudgeCounts: NudgeCounts = { ...EMPTY_NUDGE_COUNTS };
/** Snapshot of the PREVIOUS send's `nudgeCounts`, captured by `resetTurnTelemetry()`. */
let previousSendNudgeCounts: NudgeCounts = { ...EMPTY_NUDGE_COUNTS };
/** Snapshot of the PREVIOUS send's repair count, captured by `resetTurnTelemetry()` — drives send-boundary escalation (send-escalation.ts). */
let previousSendRepairCount = 0;

export function resetTurnTelemetry(): void {
  // Snapshot THIS (about-to-be-superseded) send's nudge counts as "previous"
  // before zeroing them for the new send — `agent-service.ts`'s sendMessage
  // calls this once, up front, then later reads `getPreviousSendNudgeCounts()`
  // while assembling the new send's prompt.
  previousSendNudgeCounts = nudgeCounts;
  previousSendRepairCount = current.repairCount;
  nudgeCounts = { ...EMPTY_NUDGE_COUNTS };
  current = { ...EMPTY_TELEMETRY };
}

/** Read-only peek at the PREVIOUS send's nudge counts (T9, Part 4) — consulted by `agent-service.ts` at send time. */
export function getPreviousSendNudgeCounts(): NudgeCounts {
  return { ...previousSendNudgeCounts };
}

/**
 * Read-only peek at the PREVIOUS send's final repair count — consulted by
 * `send-escalation.ts` when deciding whether the NEXT send should run on a
 * stronger tier. (Mid-send escalation was removed: switching models inside a
 * send resets the provider's prompt-prefix cache for the whole conversation.)
 */
export function getPreviousSendRepairCount(): number {
  return previousSendRepairCount;
}

/**
 * Pure predicate (T9, Part 4): should this send's outgoing prompt carry the
 * "maintain your todo list" reminder? True when the previous send did
 * substantial mutating work (>=3 write/edit/bash calls) without ever calling
 * `todo_update`.
 */
export function shouldNudgeTodoUpdate(mutatingCalls: number, todoUpdateCalls: number): boolean {
  return mutatingCalls >= 3 && todoUpdateCalls === 0;
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
 * Read-only peek at the current repair count. Unlike `nextTurnTelemetry`,
 * this does NOT increment `turnIndex` — reading telemetry isn't itself a new
 * outgoing request.
 */
export function getRepairCount(): number {
  return current.repairCount;
}

/**
 * Marks this send as escalated (`send-escalation.ts`) when it runs on a
 * bumped tier, so every request's telemetry snapshot (and the request
 * metadata sent to the server) carries it. Idempotent.
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

/**
 * A gate note counts as a REPAIR only when it reports problems to fix.
 *
 * The old rule was "carries a marker and doesn't say `] Clean`", which counted
 * every DEGRADED outcome as a repair: "Unity bridge not connected — compile
 * status unknown", "Assets refreshed — no recompile was needed", "Compile
 * status unknown (timeout)". `repairCount` feeds `send-escalation.ts`
 * (threshold 2), which latches the conversation onto a costlier model tier for
 * the rest of the session — so simply working with Unity closed escalated the
 * user after two writes, permanently, with nothing to repair.
 *
 * All three gates report counts the same way (`N compiler error(s)`,
 * `N error(s) in <file>`, `N error-severity issue(s)`), and none of the neutral
 * or degraded notes does — that literal `(s)` is the discriminator.
 */
const REPAIR_COUNT_PATTERN = /\d+\s[^\n]*?(?:error|issue)\(s\)/;

export function isRepairNote(text: string): boolean {
  if (!REPAIR_MARKERS.some((m) => text.includes(m))) return false;
  return REPAIR_COUNT_PATTERN.test(text);
}

export function recordTelemetryEvent(event: AgentEvent): void {
  if (event.type === 'tool_execution_end') {
    if (event.isError) {
      current.toolErrorCount++;
    }
    // T9 Part 4: count regardless of error — an attempted mutation is still
    // work the model should have been tracking, and a failed todo_update
    // call still counts as the model having tried to use the tool.
    if (MUTATING_TOOL_NAMES.has(event.toolName)) {
      nudgeCounts.mutatingCalls++;
    } else if (event.toolName === 'todo_update') {
      nudgeCounts.todoUpdateCalls++;
    }
    return;
  }
  if (event.type === 'message_end' && event.message.role === 'toolResult') {
    const c = event.message.content;
    const text = typeof c === 'string' ? c : '';
    if (isRepairNote(text)) {
      current.repairCount++;
    }
  }
}
