import { describe, it, expect, beforeEach } from 'bun:test';
import {
  isRepairNote,
  resetTurnTelemetry,
  nextTurnTelemetry,
  recordTelemetryEvent,
  recordGroundingLintHit,
  recordLoopGuardHit,
  getRepairCount,
  recordEscalation,
  recordGroundingToolCall,
  recordGroundingUnavailable,
  recordTurnLatency,
  getPreviousSendNudgeCounts,
  shouldNudgeTodoUpdate,
} from './turn-telemetry';
import type { AgentEvent } from './vendor/types';

const toolEnd = (isError: boolean, toolName = 'edit'): AgentEvent =>
  ({ type: 'tool_execution_end', toolCallId: 't1', toolName, result: { content: [] }, isError }) as AgentEvent;

const repairResult = (text: string): AgentEvent =>
  ({
    type: 'message_end',
    message: { role: 'toolResult', toolCallId: 't1', toolName: 'edit', content: text, isError: false, timestamp: 1 },
  }) as AgentEvent;

describe('turn telemetry', () => {
  beforeEach(() => resetTurnTelemetry());

  it('increments turnIndex per LLM request', () => {
    expect(nextTurnTelemetry().turnIndex).toBe(1);
    expect(nextTurnTelemetry().turnIndex).toBe(2);
  });

  it('counts tool errors', () => {
    recordTelemetryEvent(toolEnd(true));
    recordTelemetryEvent(toolEnd(false));
    expect(nextTurnTelemetry().toolErrorCount).toBe(1);
  });

  it('counts compile/analyzer repair feedback but not clean compiles', () => {
    recordTelemetryEvent(repairResult('[Unity compile] 2 compiler error(s) after writing X'));
    recordTelemetryEvent(repairResult('[Unity analyzers] 1 error-severity issue(s)'));
    recordTelemetryEvent(repairResult('[Unity compile] Clean'));
    expect(nextTurnTelemetry().repairCount).toBe(2);
  });

  it('counts LSP diagnostics gate repair feedback (P3.3)', () => {
    recordTelemetryEvent(repairResult('[C# language server] 1 error(s) in Foo.cs:\n  • line 3: CS0246'));
    expect(nextTurnTelemetry().repairCount).toBe(1);
  });

  it('counts grounding-lint revise hits and resets to 0 per send', () => {
    expect(nextTurnTelemetry().groundingLintHits).toBe(0);
    recordGroundingLintHit();
    expect(nextTurnTelemetry().groundingLintHits).toBe(1);
    resetTurnTelemetry();
    expect(nextTurnTelemetry().groundingLintHits).toBe(0);
  });

  it('counts repeat-call-guard suppressions and resets to 0 per send (P3.2)', () => {
    expect(nextTurnTelemetry().loopGuardHits).toBe(0);
    recordLoopGuardHit();
    recordLoopGuardHit();
    expect(nextTurnTelemetry().loopGuardHits).toBe(2);
    resetTurnTelemetry();
    expect(nextTurnTelemetry().loopGuardHits).toBe(0);
  });

  it('snapshots the previous send repair count at reset (send-boundary escalation)', () => {
    const { getPreviousSendRepairCount, recordTelemetryEvent: rec, resetTurnTelemetry: reset } =
      require('./turn-telemetry') as typeof import('./turn-telemetry');
    reset();
    rec({
      type: 'message_end',
      message: { role: 'toolResult', toolCallId: 'c', toolName: 'write', content: '[Unity compile] 2 compiler error(s) after writing Assets/A.cs', isError: true, timestamp: 1 },
    } as never);
    reset(); // snapshot happens here
    expect(getPreviousSendRepairCount()).toBe(1);
    reset(); // a clean send resets the snapshot
    expect(getPreviousSendRepairCount()).toBe(0);
  });

  it('exposes the repair count via getRepairCount without incrementing turnIndex (P3.6)', () => {
    recordTelemetryEvent(repairResult('[Unity compile] 2 compiler error(s) after writing X'));
    expect(getRepairCount()).toBe(1);
    expect(getRepairCount()).toBe(1); // peek-only, no side effects
    expect(nextTurnTelemetry().turnIndex).toBe(1); // untouched by the peeks above
  });

  it('escalated defaults to false, can be recorded, and resets to false per send (P3.6)', () => {
    expect(nextTurnTelemetry().escalated).toBe(false);
    recordEscalation();
    expect(nextTurnTelemetry().escalated).toBe(true);
    resetTurnTelemetry();
    expect(nextTurnTelemetry().escalated).toBe(false);
  });

  it('counts grounding tool calls via recordGroundingToolCall and resets to 0 per send (P4)', () => {
    expect(nextTurnTelemetry().groundingToolCalls).toBe(0);
    recordGroundingToolCall();
    recordGroundingToolCall();
    expect(nextTurnTelemetry().groundingToolCalls).toBe(2);
    resetTurnTelemetry();
    expect(nextTurnTelemetry().groundingToolCalls).toBe(0);
  });

  it('tool_execution_end for unity_api_search no longer increments groundingToolCalls (P4)', () => {
    // Counter is now at the execution layer in api-search-tool.ts, not here
    expect(nextTurnTelemetry().groundingToolCalls).toBe(0);
    recordTelemetryEvent(toolEnd(false, 'unity_api_search'));
    recordTelemetryEvent(toolEnd(false, 'unity_api_search'));
    expect(nextTurnTelemetry().groundingToolCalls).toBe(0);
  });

  it('counts grounding-unavailable results and resets to 0 per send (P4)', () => {
    expect(nextTurnTelemetry().groundingUnavailable).toBe(0);
    recordGroundingUnavailable();
    recordGroundingUnavailable();
    expect(nextTurnTelemetry().groundingUnavailable).toBe(2);
    resetTurnTelemetry();
    expect(nextTurnTelemetry().groundingUnavailable).toBe(0);
  });

  it('lastTurnLatencyMs defaults to null, can be recorded, and resets to null per send (P4)', () => {
    expect(nextTurnTelemetry().lastTurnLatencyMs).toBeNull();
    recordTurnLatency(1234);
    expect(nextTurnTelemetry().lastTurnLatencyMs).toBe(1234);
    recordTurnLatency(42); // overwrites — only the latest completed request's latency is kept
    expect(nextTurnTelemetry().lastTurnLatencyMs).toBe(42);
    resetTurnTelemetry();
    expect(nextTurnTelemetry().lastTurnLatencyMs).toBeNull();
  });
});

describe('shouldNudgeTodoUpdate (T9, Part 4 — pure predicate)', () => {
  it('nudges when the previous send had >=3 mutating calls and 0 todo_update calls', () => {
    expect(shouldNudgeTodoUpdate(3, 0)).toBe(true);
    expect(shouldNudgeTodoUpdate(5, 0)).toBe(true);
  });

  it('does not nudge below the 3-mutating-call threshold', () => {
    expect(shouldNudgeTodoUpdate(0, 0)).toBe(false);
    expect(shouldNudgeTodoUpdate(2, 0)).toBe(false);
  });

  it('does not nudge once todo_update was called at least once, regardless of mutating count', () => {
    expect(shouldNudgeTodoUpdate(10, 1)).toBe(false);
    expect(shouldNudgeTodoUpdate(3, 1)).toBe(false);
  });
});

describe('nudge counts (T9, Part 4 — local-only, never sent to the server)', () => {
  beforeEach(() => resetTurnTelemetry());

  it('defaults to zero counts with nothing recorded', () => {
    resetTurnTelemetry(); // roll the empty starting state into "previous"
    expect(getPreviousSendNudgeCounts()).toEqual({ mutatingCalls: 0, todoUpdateCalls: 0 });
  });

  it('counts write/edit/bash tool_execution_end calls as mutating, and todo_update separately', () => {
    recordTelemetryEvent(toolEnd(false, 'write'));
    recordTelemetryEvent(toolEnd(false, 'edit'));
    recordTelemetryEvent(toolEnd(true, 'bash')); // errors still count as an attempted mutation
    recordTelemetryEvent(toolEnd(false, 'todo_update'));
    recordTelemetryEvent(toolEnd(false, 'read')); // not mutating, not todo_update — ignored

    resetTurnTelemetry(); // rolls this send's counts into "previous" for the next send
    expect(getPreviousSendNudgeCounts()).toEqual({ mutatingCalls: 3, todoUpdateCalls: 1 });
  });

  it('does not count ask_user tool_execution_end calls as mutating (P? — ask_user never mutates)', () => {
    recordTelemetryEvent(toolEnd(false, 'ask_user'));
    recordTelemetryEvent(toolEnd(false, 'ask_user'));

    resetTurnTelemetry();
    expect(getPreviousSendNudgeCounts()).toEqual({ mutatingCalls: 0, todoUpdateCalls: 0 });
  });

  it('never leaks into the reported TurnTelemetry (metadata.telemetry) snapshot', () => {
    recordTelemetryEvent(toolEnd(false, 'write'));
    recordTelemetryEvent(toolEnd(false, 'write'));
    recordTelemetryEvent(toolEnd(false, 'write'));
    const snapshot = nextTurnTelemetry() as unknown as Record<string, unknown>;
    expect(snapshot.mutatingCalls).toBeUndefined();
    expect(snapshot.todoUpdateCalls).toBeUndefined();
  });

  it('resets nudge counts to zero for the new send after snapshotting "previous"', () => {
    recordTelemetryEvent(toolEnd(false, 'write'));
    recordTelemetryEvent(toolEnd(false, 'write'));
    recordTelemetryEvent(toolEnd(false, 'write'));
    resetTurnTelemetry();
    expect(getPreviousSendNudgeCounts()).toEqual({ mutatingCalls: 3, todoUpdateCalls: 0 });
    // A second consecutive reset (e.g. a send with no tool calls at all)
    // rolls the now-empty counts forward — "previous" reflects THAT send, not
    // the one before it.
    resetTurnTelemetry();
    expect(getPreviousSendNudgeCounts()).toEqual({ mutatingCalls: 0, todoUpdateCalls: 0 });
  });
});

// `repairCount` feeds `send-escalation.ts` (threshold 2), which latches the
// conversation onto a costlier model tier for the rest of the session. The old
// rule counted every note that wasn't literally "] Clean", so a user working
// with Unity closed got escalated after two writes with nothing to repair.
describe('isRepairNote', () => {
  const repairs = [
    '[Unity compile] 3 compiler error(s) after writing Assets/A.cs — fix before finishing:',
    '[Unity compile] Still 2 compiler error(s) after 4 attempts — stop auto-fixing',
    '[C# language server] 5 error(s) in Assets/A.cs:',
    '[Unity analyzers] 2 error-severity issue(s) introduced by this C# write — fix them',
  ];
  for (const note of repairs) {
    it(`counts "${note.slice(0, 44)}…"`, () => {
      expect(isRepairNote(note)).toBe(true);
    });
  }

  const notRepairs = [
    '[Unity compile] Clean — no compiler errors.',
    '[Unity compile] Unity bridge not connected — compile status unknown; the change was written.',
    '[Unity compile] Assets refreshed — no recompile was needed.',
    '[Unity compile] Compile status unknown (timeout). Retry the editor step after reconnect.',
    '[Unity compile] Compile status unknown (bridge-lost).',
  ];
  for (const note of notRepairs) {
    it(`does not count "${note.slice(0, 44)}…"`, () => {
      expect(isRepairNote(note)).toBe(false);
    });
  }

  it('ignores ordinary tool output that carries no gate marker', () => {
    expect(isRepairNote('Successfully wrote 120 bytes (2 lines) to Assets/A.cs')).toBe(false);
    expect(isRepairNote('found 3 error(s) in the log')).toBe(false);
  });
});
