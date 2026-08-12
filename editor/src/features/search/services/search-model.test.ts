import { describe, it, expect } from 'bun:test';
import {
  parseGlobList,
  applyBatch,
  applyComplete,
  autoSearchAction,
  MIN_AUTO_SEARCH_CHARS,
  type StreamState,
} from './search-model';
import type { FileSearchResult } from '../../../types';

function file(path: string, matchCount = 1, extra: Partial<FileSearchResult> = {}): FileSearchResult {
  return {
    path,
    matches: Array.from({ length: matchCount }, (_, i) => ({
      lineNumber: i + 1,
      lineContent: `line ${i + 1}`,
      matchStart: 0,
      matchEnd: 3,
      lineStart: 0,
    })),
    ...extra,
  };
}

function baseState(overrides: Partial<StreamState> = {}): StreamState {
  return {
    results: [],
    totalMatches: 0,
    fileCount: 0,
    truncated: false,
    isSearching: true,
    activeSearchId: 1,
    receivedFirstBatch: false,
    ...overrides,
  };
}

describe('parseGlobList', () => {
  it('returns an empty array for an empty string', () => {
    expect(parseGlobList('')).toEqual([]);
  });

  it('returns an empty array for a whitespace-only string', () => {
    expect(parseGlobList('   ')).toEqual([]);
  });

  it('splits a single pattern into a one-element array', () => {
    expect(parseGlobList('*.ts')).toEqual(['*.ts']);
  });

  it('splits comma-separated patterns and trims surrounding whitespace', () => {
    expect(parseGlobList(' *.ts , *.tsx ')).toEqual(['*.ts', '*.tsx']);
  });

  it('drops empty entries produced by consecutive/trailing/leading commas', () => {
    expect(parseGlobList('*.ts,,*.tsx,')).toEqual(['*.ts', '*.tsx']);
    expect(parseGlobList(',*.ts')).toEqual(['*.ts']);
  });

  it('drops entries that are only whitespace between commas', () => {
    expect(parseGlobList('*.ts,   ,*.tsx')).toEqual(['*.ts', '*.tsx']);
  });

  it('does not deduplicate repeated patterns (caller responsibility, not this parser)', () => {
    expect(parseGlobList('*.ts,*.ts')).toEqual(['*.ts', '*.ts']);
  });

  it('a comma-only string yields an empty array', () => {
    expect(parseGlobList(',,,')).toEqual([]);
  });
});

describe('applyBatch', () => {
  it('is a no-op for a stale searchId (returns the exact same state reference)', () => {
    const state = baseState({ activeSearchId: 2, results: [file('a.ts')] });
    const next = applyBatch(state, { searchId: 1, results: [file('b.ts')] });
    expect(next).toBe(state);
  });

  it('REPLACES results on the first batch for the active id, even if previous results existed', () => {
    // D4: previous search's results are still visible when a new search starts
    // streaming (search() does not clear `results` up front). The first batch
    // for the new active id must blow those stale results away rather than
    // appending to them.
    const state = baseState({
      activeSearchId: 5,
      results: [file('stale-from-old-search.ts')],
      receivedFirstBatch: false,
    });
    const next = applyBatch(state, { searchId: 5, results: [file('a.ts'), file('b.ts')] });
    expect(next.results.map((r) => r.path)).toEqual(['a.ts', 'b.ts']);
    expect(next.receivedFirstBatch).toBe(true);
  });

  it('APPENDS on subsequent batches for the same active id (after the first)', () => {
    const state = baseState({
      activeSearchId: 5,
      results: [file('a.ts')],
      receivedFirstBatch: true,
    });
    const next = applyBatch(state, { searchId: 5, results: [file('b.ts')] });
    expect(next.results.map((r) => r.path)).toEqual(['a.ts', 'b.ts']);
    expect(next.receivedFirstBatch).toBe(true);
  });

  it('a sequence of first-then-second batch replaces then appends correctly', () => {
    let state = baseState({ activeSearchId: 7, results: [file('leftover.ts')] });
    state = applyBatch(state, { searchId: 7, results: [file('a.ts')] });
    expect(state.results.map((r) => r.path)).toEqual(['a.ts']);
    state = applyBatch(state, { searchId: 7, results: [file('b.ts')] });
    expect(state.results.map((r) => r.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('preserves other fields (totalMatches/fileCount/truncated/isSearching) untouched', () => {
    const state = baseState({
      activeSearchId: 3,
      totalMatches: 42,
      fileCount: 7,
      truncated: true,
      isSearching: true,
    });
    const next = applyBatch(state, { searchId: 3, results: [file('a.ts')] });
    expect(next.totalMatches).toBe(42);
    expect(next.fileCount).toBe(7);
    expect(next.truncated).toBe(true);
    expect(next.isSearching).toBe(true);
  });
});

describe('applyComplete', () => {
  it('is a no-op for a stale searchId (returns the exact same state reference)', () => {
    const state = baseState({ activeSearchId: 2, isSearching: true });
    const next = applyComplete(state, {
      searchId: 1,
      totalMatches: 10,
      fileCount: 2,
      truncated: false,
      cancelled: false,
      elapsedMs: 5,
    });
    expect(next).toBe(state);
  });

  it('a stale cancelled completion is also a pure no-op (the superseding search owns state now)', () => {
    // This is the common cancellation path: search() for id 2 already moved
    // activeSearchId to 2 before the backend's cancellation of id 1 round-trips
    // back, so id 1's cancelled completion is just stale and must not touch
    // anything id-2's own events are managing.
    const state = baseState({ activeSearchId: 2, isSearching: true, results: [file('from-search-2.ts')] });
    const next = applyComplete(state, {
      searchId: 1,
      totalMatches: 0,
      fileCount: 0,
      truncated: false,
      cancelled: true,
      elapsedMs: 5,
    });
    expect(next).toBe(state);
  });

  it('zero batches received + successful (non-cancelled) complete for the active id → results = []', () => {
    const state = baseState({
      activeSearchId: 4,
      receivedFirstBatch: false,
      results: [file('stale-from-previous-search.ts')],
      isSearching: true,
    });
    const next = applyComplete(state, {
      searchId: 4,
      totalMatches: 0,
      fileCount: 0,
      truncated: false,
      cancelled: false,
      elapsedMs: 12,
    });
    expect(next.results).toEqual([]);
    expect(next.isSearching).toBe(false);
  });

  it('successful complete after batches were received keeps the accumulated results as-is', () => {
    const accumulated = [file('a.ts'), file('b.ts')];
    const state = baseState({
      activeSearchId: 4,
      receivedFirstBatch: true,
      results: accumulated,
      isSearching: true,
    });
    const next = applyComplete(state, {
      searchId: 4,
      totalMatches: 2,
      fileCount: 2,
      truncated: false,
      cancelled: false,
      elapsedMs: 12,
    });
    expect(next.results).toBe(accumulated);
  });

  it('successful complete carries totalMatches/fileCount/truncated from the payload into state', () => {
    const state = baseState({ activeSearchId: 9, receivedFirstBatch: true, results: [file('a.ts')] });
    const next = applyComplete(state, {
      searchId: 9,
      totalMatches: 123,
      fileCount: 8,
      truncated: true,
      cancelled: false,
      elapsedMs: 99,
    });
    expect(next.totalMatches).toBe(123);
    expect(next.fileCount).toBe(8);
    expect(next.truncated).toBe(true);
  });

  it('successful complete always clears isSearching', () => {
    const state = baseState({ activeSearchId: 9, isSearching: true });
    const next = applyComplete(state, {
      searchId: 9,
      totalMatches: 0,
      fileCount: 0,
      truncated: false,
      cancelled: false,
      elapsedMs: 1,
    });
    expect(next.isSearching).toBe(false);
  });

  it(
    'defense-in-depth: a cancelled completion that (unusually) still matches the active id ' +
      'clears isSearching but does NOT touch results/totals — the caller that triggered the ' +
      'cancellation (clearResults) owns resetting those, not this event',
    () => {
      const state = baseState({
        activeSearchId: 4,
        results: [file('do-not-touch.ts')],
        totalMatches: 55,
        fileCount: 3,
        truncated: true,
        isSearching: true,
      });
      const next = applyComplete(state, {
        searchId: 4,
        totalMatches: 999,
        fileCount: 999,
        truncated: false,
        cancelled: true,
        elapsedMs: 3,
      });
      expect(next.isSearching).toBe(false);
      expect(next.results).toBe(state.results);
      expect(next.totalMatches).toBe(55);
      expect(next.fileCount).toBe(3);
      expect(next.truncated).toBe(true);
    },
  );
});

describe('autoSearchAction', () => {
  // The panel's auto-search effect must key off the DEBOUNCED query only.
  // Regression context: `triggerSearch` (rebuilt every keystroke, since it
  // closes over the live query) used to sit in that effect's dependency list,
  // so the effect re-ran per character. Its guard — "length >= 3" — stays true
  // once you've typed three characters, so every further keystroke fired a
  // fresh full-workspace search. Keeping the decision here, as a function of
  // the debounced value alone, is what makes that shape impossible to restate.
  it('searches once the debounced query reaches the minimum length', () => {
    expect(autoSearchAction('abc')).toBe('search');
    expect(autoSearchAction('a longer query')).toBe('search');
  });

  it('clears on an empty query', () => {
    expect(autoSearchAction('')).toBe('clear');
  });

  // Below the threshold but non-empty: neither search (too broad, and every
  // keystroke would rescan) nor clear (that would wipe results the user is
  // still reading while they finish typing).
  it('does nothing for a query that is too short to search but not empty', () => {
    expect(autoSearchAction('a')).toBe('idle');
    expect(autoSearchAction('ab')).toBe('idle');
  });

  it('treats whitespace as searchable content, not emptiness', () => {
    expect(autoSearchAction('   ')).toBe('search');
  });

  it('exposes the threshold it enforces', () => {
    expect(MIN_AUTO_SEARCH_CHARS).toBe(3);
    expect(autoSearchAction('x'.repeat(MIN_AUTO_SEARCH_CHARS - 1))).toBe('idle');
    expect(autoSearchAction('x'.repeat(MIN_AUTO_SEARCH_CHARS))).toBe('search');
  });
});
