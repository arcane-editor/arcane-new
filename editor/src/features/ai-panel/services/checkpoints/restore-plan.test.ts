import { describe, it, expect } from 'bun:test';
import {
  computeRestorePlan,
  getSkippedTooLargePaths,
  type CheckpointTurn,
  type CheckpointEntry,
} from './restore-plan';

function entry(overrides: Partial<CheckpointEntry> & Pick<CheckpointEntry, 'path'>): CheckpointEntry {
  return { kind: 'modified', timestamp: 0, ...overrides };
}

function turn(turnId: string, entries: CheckpointEntry[]): CheckpointTurn {
  return { turnId, sessionId: 'sess-1', userMessageId: `msg-${turnId}`, timestamp: 0, entries };
}

describe('computeRestorePlan', () => {
  it('returns [] for an empty turn history', () => {
    expect(computeRestorePlan([], 't1')).toEqual([]);
  });

  it('returns [] when the turnId is not found', () => {
    const turns = [turn('t1', [entry({ path: '/a', kind: 'created' })])];
    expect(computeRestorePlan(turns, 'does-not-exist')).toEqual([]);
  });

  it('multi-turn overlapping paths: turn2 modifies a file turn1 created — restoring to before turn1 deletes it', () => {
    const turns = [
      turn('t1', [entry({ path: '/a', kind: 'created' })]),
      turn('t2', [entry({ path: '/a', kind: 'modified', beforeContent: 'content-after-t1' })]),
    ];

    expect(computeRestorePlan(turns, 't1')).toEqual([{ path: '/a', action: 'delete' }]);
  });

  it('the same overlapping paths, restoring to before turn2, writes back turn2s pre-image instead', () => {
    const turns = [
      turn('t1', [entry({ path: '/a', kind: 'created' })]),
      turn('t2', [entry({ path: '/a', kind: 'modified', beforeContent: 'content-after-t1' })]),
    ];

    expect(computeRestorePlan(turns, 't2')).toEqual([
      { path: '/a', action: 'write', content: 'content-after-t1' },
    ]);
  });

  it('created-then-modified within the same turn: the first (created) entry wins, not the later modify', () => {
    const turns = [
      turn('t1', [
        entry({ path: '/a', kind: 'created', timestamp: 1 }),
        entry({ path: '/a', kind: 'modified', beforeContent: 'stale', timestamp: 2 }),
      ]),
    ];

    expect(computeRestorePlan(turns, 't1')).toEqual([{ path: '/a', action: 'delete' }]);
  });

  it('restore-mid-history: only entries from turns at-or-after N count, even for a path untouched by N itself', () => {
    const turns = [
      turn('t1', [entry({ path: '/a', kind: 'modified', beforeContent: 'a-v0' })]),
      turn('t2', [entry({ path: '/b', kind: 'modified', beforeContent: 'b-v0' })]),
      turn('t3', [entry({ path: '/a', kind: 'modified', beforeContent: 'a-v1' })]),
    ];

    // Restoring to before t2: /a's only entry within [t2..] is t3's (t1 is out
    // of range), so it uses 'a-v1', not t1's 'a-v0'. /b uses t2's own entry.
    const plan = computeRestorePlan(turns, 't2');
    expect(plan).toHaveLength(2);
    expect(plan).toContainEqual({ path: '/b', action: 'write', content: 'b-v0' });
    expect(plan).toContainEqual({ path: '/a', action: 'write', content: 'a-v1' });
  });

  it('dedupe-first-write-wins: across multiple qualifying turns, the earliest touch of a path wins', () => {
    const turns = [
      turn('t1', []), // target turn itself never touches /a
      turn('t2', [entry({ path: '/a', kind: 'modified', beforeContent: 'x' })]),
      turn('t3', [entry({ path: '/a', kind: 'modified', beforeContent: 'y' })]),
    ];

    expect(computeRestorePlan(turns, 't1')).toEqual([{ path: '/a', action: 'write', content: 'x' }]);
  });

  it('tooLarge skip: a snapshot recorded as tooLarge is excluded from the plan entirely', () => {
    const turns = [
      turn('t1', [
        entry({ path: '/big', kind: 'modified', tooLarge: true }),
        entry({ path: '/small', kind: 'modified', beforeContent: 'ok' }),
      ]),
    ];

    expect(computeRestorePlan(turns, 't1')).toEqual([{ path: '/small', action: 'write', content: 'ok' }]);
  });

  it('a turn with only a tooLarge entry produces an empty plan', () => {
    const turns = [turn('t1', [entry({ path: '/big', kind: 'modified', tooLarge: true })])];
    expect(computeRestorePlan(turns, 't1')).toEqual([]);
  });
});

describe('getSkippedTooLargePaths', () => {
  it('returns [] for an empty history', () => {
    expect(getSkippedTooLargePaths([], 't1')).toEqual([]);
  });

  it('returns [] when the turnId is not found', () => {
    const turns = [turn('t1', [entry({ path: '/big', kind: 'modified', tooLarge: true })])];
    expect(getSkippedTooLargePaths(turns, 'nope')).toEqual([]);
  });

  it('lists paths whose earliest qualifying snapshot was tooLarge', () => {
    const turns = [
      turn('t1', [
        entry({ path: '/big', kind: 'modified', tooLarge: true }),
        entry({ path: '/small', kind: 'modified', beforeContent: 'ok' }),
      ]),
    ];

    expect(getSkippedTooLargePaths(turns, 't1')).toEqual(['/big']);
  });

  it('does not list a path whose earliest qualifying snapshot is NOT tooLarge, even if a later turn recorded a tooLarge one', () => {
    const turns = [
      turn('t1', [entry({ path: '/a', kind: 'modified', beforeContent: 'fine' })]),
      turn('t2', [entry({ path: '/a', kind: 'modified', tooLarge: true })]),
    ];

    // Restoring to before t1: earliest entry for /a is t1's (not tooLarge).
    expect(getSkippedTooLargePaths(turns, 't1')).toEqual([]);
    expect(computeRestorePlan(turns, 't1')).toEqual([{ path: '/a', action: 'write', content: 'fine' }]);
  });
});
