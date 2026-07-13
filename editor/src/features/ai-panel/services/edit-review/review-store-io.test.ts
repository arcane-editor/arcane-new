import { describe, it, expect } from 'bun:test';
import { serializeReviews, parseReviews } from './review-store-io';
import type { PendingReviewEntry } from './review-core';

const ENTRIES: Record<string, PendingReviewEntry> = {
  '/a': {
    path: '/a',
    turnId: 't1',
    userMessageId: 'msg-1',
    toolCallIds: ['call-1'],
    firstChangeAt: 1000,
    lastChangeAt: 1000,
  },
  '/b': {
    path: '/b',
    turnId: 't1',
    userMessageId: 'msg-1',
    toolCallIds: ['call-2', 'call-3'],
    firstChangeAt: 1001,
    lastChangeAt: 2000,
    lastRejectFailed: true,
  },
};

describe('serializeReviews / parseReviews round-trip', () => {
  it('round-trips a full entries record exactly', () => {
    const json = serializeReviews(ENTRIES);
    expect(parseReviews(json)).toEqual(ENTRIES);
  });

  it('round-trips an empty entries record', () => {
    const json = serializeReviews({});
    expect(parseReviews(json)).toEqual({});
  });

  it('produces valid, human-readable JSON', () => {
    const json = serializeReviews(ENTRIES);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json).toContain('"entries"');
  });

  it('parseReviews returns {} for malformed JSON', () => {
    expect(parseReviews('not json')).toEqual({});
  });

  it('parseReviews returns {} when the entries field is missing (legacy/foreign file)', () => {
    expect(parseReviews(JSON.stringify({ updatedAt: 1 }))).toEqual({});
  });

  it('parseReviews returns {} for an empty string', () => {
    expect(parseReviews('')).toEqual({});
  });

  it('parseReviews returns {} when entries is not an object (e.g. an array)', () => {
    expect(parseReviews(JSON.stringify({ updatedAt: 1, entries: [] }))).toEqual({});
  });

  it('parseReviews returns {} when entries is null', () => {
    expect(parseReviews(JSON.stringify({ updatedAt: 1, entries: null }))).toEqual({});
  });

  it('tolerates extra unknown top-level fields', () => {
    const json = JSON.stringify({ updatedAt: 1, entries: ENTRIES, sessionId: 'sess-1', extra: 'ignored' });
    expect(parseReviews(json)).toEqual(ENTRIES);
  });
});
