import { describe, it, expect, beforeEach } from 'bun:test';
import {
  resetTurnTelemetry,
  nextTurnTelemetry,
  recordTelemetryEvent,
  recordGroundingLintHit,
  recordLoopGuardHit,
  getRepairCount,
  recordEscalation,
} from './turn-telemetry';
import type { AgentEvent } from './vendor/types';

const toolEnd = (isError: boolean): AgentEvent =>
  ({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'edit', result: { content: [] }, isError }) as AgentEvent;

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
});
