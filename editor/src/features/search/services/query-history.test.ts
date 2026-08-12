import { describe, it, expect } from 'bun:test';
import { pushQuery, historyStep, resolveCaseSensitive, HISTORY_LIMIT } from './query-history';

describe('pushQuery', () => {
  it('adds the newest query at the front', () => {
    expect(pushQuery(['b'], 'a')).toEqual(['a', 'b']);
  });

  it('moves a repeated query to the front instead of duplicating it', () => {
    expect(pushQuery(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
  });

  it('ignores empty and whitespace-only queries', () => {
    expect(pushQuery(['a'], '')).toEqual(['a']);
    expect(pushQuery(['a'], '   ')).toEqual(['a']);
  });

  it('caps at HISTORY_LIMIT', () => {
    const full = Array.from({ length: HISTORY_LIMIT }, (_, i) => `q${i}`);
    const next = pushQuery(full, 'new');
    expect(next).toHaveLength(HISTORY_LIMIT);
    expect(next[0]).toBe('new');
    expect(next).not.toContain(`q${HISTORY_LIMIT - 1}`);
  });
});

describe('historyStep', () => {
  const history = ['a', 'b', 'c'];

  it('walks back from the live query into the history', () => {
    expect(historyStep(history, -1, 'back')).toEqual({ index: 0, query: 'a' });
    expect(historyStep(history, 0, 'back')).toEqual({ index: 1, query: 'b' });
  });

  it('stops at the oldest entry', () => {
    expect(historyStep(history, 2, 'back')).toEqual({ index: 2, query: 'c' });
  });

  it('walks forward and returns to the live query', () => {
    expect(historyStep(history, 1, 'forward')).toEqual({ index: 0, query: 'a' });
    expect(historyStep(history, 0, 'forward')).toEqual({ index: -1, query: '' });
  });

  it('does nothing when the history is empty', () => {
    expect(historyStep([], -1, 'back')).toBeNull();
  });
});

describe('resolveCaseSensitive', () => {
  it('honours the explicit toggle regardless of smartcase', () => {
    expect(resolveCaseSensitive('foo', true, true)).toBe(true);
  });

  it('goes case-sensitive for a query containing uppercase when smartcase is on', () => {
    expect(resolveCaseSensitive('Foo', false, true)).toBe(true);
  });

  it('stays insensitive for an all-lowercase query when smartcase is on', () => {
    expect(resolveCaseSensitive('foo', false, true)).toBe(false);
  });

  it('ignores case entirely when smartcase is off', () => {
    expect(resolveCaseSensitive('Foo', false, false)).toBe(false);
  });
});
