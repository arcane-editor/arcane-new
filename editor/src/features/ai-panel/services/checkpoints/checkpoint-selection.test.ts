import { describe, it, expect } from 'bun:test';
import { selectCheckpointTurnsForMessage } from './checkpoint-selection';
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
