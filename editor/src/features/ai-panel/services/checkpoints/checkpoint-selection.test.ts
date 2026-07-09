import { describe, it, expect } from 'bun:test';
import { selectCheckpointTurnsForMessage, findCheckpointTurnForPath } from './checkpoint-selection';
import type { CheckpointEntry, CheckpointTurn } from './restore-plan';

function entry(overrides: Partial<CheckpointEntry> & Pick<CheckpointEntry, 'path'>): CheckpointEntry {
  return { kind: 'modified', timestamp: 0, ...overrides };
}

function turn(
  turnId: string,
  userMessageId: string,
  entries: CheckpointEntry[],
): CheckpointTurn {
  return { turnId, sessionId: 'sess-1', userMessageId, timestamp: 0, entries };
}

describe('selectCheckpointTurnsForMessage', () => {
  it('returns [] for an empty turn history', () => {
    expect(selectCheckpointTurnsForMessage([], 'msg-1')).toEqual([]);
  });

  it('returns [] when nothing matches the userMessageId', () => {
    const turns = [turn('t1', 'msg-1', [entry({ path: '/a' })])];
    expect(selectCheckpointTurnsForMessage(turns, 'msg-other')).toEqual([]);
  });

  it('returns [] when the only matching turn is empty (no entries)', () => {
    const turns = [turn('t1', 'msg-1', [])];
    expect(selectCheckpointTurnsForMessage(turns, 'msg-1')).toEqual([]);
  });

  it('plan execution scenario: an empty plan-planning turn followed by a non-empty plan-execution turn sharing the same userMessageId — selection skips the empty one and yields the non-empty one', () => {
    const planning = turn('t1', 'msg-1', []);
    const execution = turn('t2', 'msg-1', [entry({ path: '/Foo.cs' })]);
    const turns = [planning, execution];

    expect(selectCheckpointTurnsForMessage(turns, 'msg-1')).toEqual([execution]);
  });

  it('returns every non-empty turn for the message, in original chronological order, when a plan is executed more than once', () => {
    const planning = turn('t1', 'msg-1', []);
    const firstExecution = turn('t2', 'msg-1', [entry({ path: '/A.cs' })]);
    const secondExecution = turn('t3', 'msg-1', [entry({ path: '/B.cs' })]);
    const turns = [planning, firstExecution, secondExecution];

    expect(selectCheckpointTurnsForMessage(turns, 'msg-1')).toEqual([firstExecution, secondExecution]);
  });

  it('does not include a non-empty turn belonging to a different user message', () => {
    const mine = turn('t1', 'msg-1', [entry({ path: '/a' })]);
    const other = turn('t2', 'msg-2', [entry({ path: '/b' })]);
    const turns = [mine, other];

    expect(selectCheckpointTurnsForMessage(turns, 'msg-1')).toEqual([mine]);
  });
});

// P5.1: per-file Revert button on a diff needs to find the checkpoint turn to
// restore against. `CheckpointEntry.toolCallId` (restore-plan.ts) documents
// itself as "if known" but is never actually threaded through —
// `checkpoint-gate.ts`'s `recordPreWrite` call, and the store action's own
// signature, don't carry a toolCallId at all. Per the P5.1 brief, the
// documented fallback is to match by (user-message turn, path) instead.
describe('findCheckpointTurnForPath', () => {
  it('returns undefined when nothing matches the userMessageId', () => {
    const turns = [turn('t1', 'msg-1', [entry({ path: '/Foo.cs' })])];
    expect(findCheckpointTurnForPath(turns, 'msg-other', '/Foo.cs')).toBeUndefined();
  });

  it('returns undefined when the message has turns but none touched this path', () => {
    const turns = [turn('t1', 'msg-1', [entry({ path: '/Foo.cs' })])];
    expect(findCheckpointTurnForPath(turns, 'msg-1', '/Bar.cs')).toBeUndefined();
  });

  it('finds the turn for this message that recorded the path', () => {
    const t1 = turn('t1', 'msg-1', [entry({ path: '/Foo.cs' })]);
    expect(findCheckpointTurnForPath([t1], 'msg-1', '/Foo.cs')).toBe(t1);
  });

  it('plan-execution scenario: skips the empty planning turn and finds the execution turn', () => {
    const planning = turn('t1', 'msg-1', []);
    const execution = turn('t2', 'msg-1', [entry({ path: '/Foo.cs' })]);
    const turns = [planning, execution];
    expect(findCheckpointTurnForPath(turns, 'msg-1', '/Foo.cs')).toBe(execution);
  });

  it('when multiple turns for this message touched the same path, picks the LAST (most recent) one', () => {
    const first = turn('t1', 'msg-1', [entry({ path: '/Foo.cs' })]);
    const second = turn('t2', 'msg-1', [entry({ path: '/Foo.cs' })]);
    const turns = [first, second];
    expect(findCheckpointTurnForPath(turns, 'msg-1', '/Foo.cs')).toBe(second);
  });

  it('does not match a turn belonging to a different user message', () => {
    const other = turn('t1', 'msg-2', [entry({ path: '/Foo.cs' })]);
    expect(findCheckpointTurnForPath([other], 'msg-1', '/Foo.cs')).toBeUndefined();
  });
});
