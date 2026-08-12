import { describe, it, expect } from 'bun:test';
import { buildExcerpts, applyExpansion, excerptId } from './excerpt-model';
import type { FileSearchResult } from '../../../types';

function match(lineNumber: number, lineContent: string, before: string[] = [], after: string[] = []) {
  return {
    lineNumber,
    lineContent,
    matchStart: 0,
    matchEnd: 3,
    lineStart: 0,
    before,
    after,
  };
}

describe('buildExcerpts', () => {
  it('turns one match into one excerpt spanning its context', () => {
    const file: FileSearchResult = {
      path: '/w/a.ts',
      matches: [match(3, 'hit', ['a', 'b'], ['c', 'd'])],
    };
    const [ex] = buildExcerpts(file);
    expect(ex.startLine).toBe(1);
    expect(ex.endLine).toBe(5);
    expect(ex.lines.map((l) => l.text)).toEqual(['a', 'b', 'hit', 'c', 'd']);
    expect(ex.lines[2].matches).toEqual([{ start: 0, end: 3 }]);
    expect(ex.matchCount).toBe(1);
  });

  it('merges matches whose context windows overlap into one excerpt', () => {
    const file: FileSearchResult = {
      path: '/w/a.ts',
      matches: [
        match(3, 'hit', ['a', 'b'], ['c', 'd']),
        match(6, 'hit', ['d', 'e'], ['g', 'h']),
      ],
    };
    const excerpts = buildExcerpts(file);
    expect(excerpts).toHaveLength(1);
    expect(excerpts[0].startLine).toBe(1);
    expect(excerpts[0].endLine).toBe(8);
    expect(excerpts[0].matchCount).toBe(2);
    // Line 5 came from both windows and must appear exactly once.
    expect(excerpts[0].lines.filter((l) => l.lineNumber === 5)).toHaveLength(1);
  });

  it('keeps distant matches as separate excerpts', () => {
    const file: FileSearchResult = {
      path: '/w/a.ts',
      matches: [match(3, 'hit', ['a', 'b'], ['c', 'd']), match(40, 'hit', ['x'], ['y'])],
    };
    const excerpts = buildExcerpts(file);
    expect(excerpts).toHaveLength(2);
    expect(excerpts[1].startLine).toBe(39);
  });

  it('folds two matches on the same line into one line with two ranges', () => {
    const file: FileSearchResult = {
      path: '/w/a.ts',
      matches: [
        { ...match(3, 'hit and hit'), matchStart: 0, matchEnd: 3 },
        { ...match(3, 'hit and hit'), matchStart: 8, matchEnd: 11 },
      ],
    };
    const [ex] = buildExcerpts(file);
    expect(ex.lines.filter((l) => l.lineNumber === 3)).toHaveLength(1);
    expect(ex.lines.find((l) => l.lineNumber === 3)!.matches).toEqual([
      { start: 0, end: 3 },
      { start: 8, end: 11 },
    ]);
    expect(ex.matchCount).toBe(2);
  });

  it('drops highlight ranges from a differently-trimmed window but still counts the match', () => {
    // A long line trimmed around each match yields different lineStart values;
    // the two windows show different text, so only the first can be rendered.
    const file: FileSearchResult = {
      path: '/w/a.ts',
      matches: [
        { ...match(3, 'window-one'), lineStart: 0, matchStart: 0, matchEnd: 3 },
        { ...match(3, 'window-two'), lineStart: 400, matchStart: 2, matchEnd: 5 },
      ],
    };
    const [ex] = buildExcerpts(file);
    const line = ex.lines.find((l) => l.lineNumber === 3)!;
    expect(line.text).toBe('window-one');
    expect(line.matches).toEqual([{ start: 0, end: 3 }]);
    expect(ex.matchCount).toBe(2);
  });

  it('handles a match with no context at all', () => {
    const file: FileSearchResult = { path: '/w/a.ts', matches: [match(1, 'hit')] };
    const [ex] = buildExcerpts(file);
    expect(ex.startLine).toBe(1);
    expect(ex.endLine).toBe(1);
    expect(ex.lines).toHaveLength(1);
  });

  it('returns no excerpts for a file with an empty match list', () => {
    // A file result can arrive as the tail of a truncated batch with zero
    // matches; that must not render as a spurious empty excerpt box.
    const file: FileSearchResult = { path: '/w/a.ts', matches: [] };
    expect(buildExcerpts(file)).toEqual([]);
  });
});

describe('excerptId', () => {
  it('is stable for a file and start line', () => {
    expect(excerptId('/w/a.ts', 12)).toBe('/w/a.ts:12');
  });
});

describe('applyExpansion', () => {
  const fileLines = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'];

  it('reveals lines above and below from the real file', () => {
    const file: FileSearchResult = { path: '/w/a.ts', matches: [match(4, 'l4')] };
    const [ex] = buildExcerpts(file);
    const grown = applyExpansion(ex, fileLines, { up: 2, down: 1 });
    expect(grown.startLine).toBe(2);
    expect(grown.endLine).toBe(5);
    expect(grown.lines.map((l) => l.text)).toEqual(['l2', 'l3', 'l4', 'l5']);
  });

  it('clamps at both file boundaries', () => {
    const file: FileSearchResult = { path: '/w/a.ts', matches: [match(1, 'l1')] };
    const [ex] = buildExcerpts(file);
    const grown = applyExpansion(ex, fileLines, { up: 5, down: 99 });
    expect(grown.startLine).toBe(1);
    expect(grown.endLine).toBe(7);
  });

  it('preserves match highlight ranges on the match line', () => {
    const file: FileSearchResult = { path: '/w/a.ts', matches: [match(4, 'l4')] };
    const [ex] = buildExcerpts(file);
    const grown = applyExpansion(ex, fileLines, { up: 1, down: 0 });
    expect(grown.lines.find((l) => l.lineNumber === 4)!.matches).toEqual([{ start: 0, end: 3 }]);
  });

  it('is a no-op when expansion is zero', () => {
    // The renderer calls applyExpansion on every excerpt that has any
    // expansion state at all, including { up: 0, down: 0 }; that call must
    // not corrupt the excerpt's lines (e.g. by dropping highlight ranges or
    // re-deriving text from fileLines instead of reusing the known lines).
    const file: FileSearchResult = {
      path: '/w/a.ts',
      matches: [match(4, 'l4', ['l2', 'l3'], ['l5', 'l6'])],
    };
    const [ex] = buildExcerpts(file);
    const grown = applyExpansion(ex, fileLines, { up: 0, down: 0 });
    expect(grown.startLine).toBe(ex.startLine);
    expect(grown.endLine).toBe(ex.endLine);
    expect(grown.lines).toEqual(ex.lines);
  });
});
