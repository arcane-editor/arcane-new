import { describe, it, expect } from 'bun:test';
import { serializeCheckpoints, parseCheckpoints } from './checkpoint-store-io';
import type { CheckpointTurn } from './restore-plan';

const TURNS: CheckpointTurn[] = [
  {
    turnId: 't1',
    sessionId: 'sess-1',
    userMessageId: 'msg-1',
    timestamp: 1000,
    entries: [
      { path: '/a', kind: 'created', timestamp: 1000 },
      { path: '/b', kind: 'modified', beforeContent: 'old content', timestamp: 1001 },
    ],
  },
  {
    turnId: 't2',
    sessionId: 'sess-1',
    userMessageId: 'msg-2',
    timestamp: 2000,
    entries: [{ path: '/c', kind: 'modified', tooLarge: true, timestamp: 2000 }],
  },
];

describe('serializeCheckpoints / parseCheckpoints round-trip', () => {
  it('round-trips a full turn history exactly', () => {
    const json = serializeCheckpoints('sess-1', TURNS);
    expect(parseCheckpoints(json)).toEqual(TURNS);
  });

  it('round-trips an empty turn history', () => {
    const json = serializeCheckpoints('sess-1', []);
    expect(parseCheckpoints(json)).toEqual([]);
  });

  it('produces valid, human-readable JSON containing the sessionId', () => {
    const json = serializeCheckpoints('sess-1', TURNS);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json).toContain('"sessionId": "sess-1"');
  });

  it('parseCheckpoints returns [] for malformed JSON', () => {
    expect(parseCheckpoints('not json')).toEqual([]);
  });

  it('parseCheckpoints returns [] when the turns field is missing', () => {
    expect(parseCheckpoints(JSON.stringify({ sessionId: 'sess-1', updatedAt: 1 }))).toEqual([]);
  });

  it('parseCheckpoints returns [] for an empty string', () => {
    expect(parseCheckpoints('')).toEqual([]);
  });
});
