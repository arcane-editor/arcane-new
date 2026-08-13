import { describe, it, expect } from 'bun:test';
import { buildExcerpts, excerptId } from './excerpt-model';
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

  it('carries a preview-trimmed match line\'s lineStart onto its ExcerptLine', () => {
    // The real editor column for a match is `lineStart + matchStart`, not
    // `matchStart` alone (src/types/index.ts, SearchMatch.lineStart) — a long
    // line gets preview-trimmed around its match, so matchStart is an offset
    // into the TRIMMED text, not the real file line. buildExcerpts must carry
    // that offset through onto the rendered ExcerptLine so a consumer can
    // reconstruct the real column.
    const file: FileSearchResult = {
      path: '/w/a.ts',
      matches: [{ ...match(3, 'trimmed window'), lineStart: 250, matchStart: 2, matchEnd: 9 }],
    };
    const [ex] = buildExcerpts(file);
    const line = ex.lines.find((l) => l.lineNumber === 3)!;
    expect(line.lineStart).toBe(250);
  });

  it('gives every line lineStart 0 when nothing was preview-trimmed', () => {
    // Context lines (before/after) are never preview-trimmed by the backend,
    // and a match line with the default lineStart (0) means the same. Every
    // line in an ordinary, untruncated excerpt must read back as untrimmed.
    const file: FileSearchResult = {
      path: '/w/a.ts',
      matches: [match(3, 'hit', ['a', 'b'], ['c', 'd'])],
    };
    const [ex] = buildExcerpts(file);
    expect(ex.lines.every((l) => l.lineStart === 0)).toBe(true);
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

  it('merges matches exactly 5 lines apart (context 2 either side) into one excerpt', () => {
    // Windows are [L-2, L+2] with 2 lines of context either side. Two windows
    // merge iff next.start <= current.end + 1, i.e. L2 - 2 <= L1 + 2 + 1,
    // i.e. L2 <= L1 + 5 — this test sits exactly on that boundary.
    const file: FileSearchResult = {
      path: '/w/a.ts',
      matches: [
        match(10, 'hit', ['a', 'b'], ['c', 'd']),
        match(15, 'hit', ['e', 'f'], ['g', 'h']),
      ],
    };
    expect(buildExcerpts(file)).toHaveLength(1);
  });

  it('keeps matches exactly 6 lines apart (context 2 either side) as separate excerpts', () => {
    // One line further than the boundary above: next.start (14) is no
    // longer <= current.end + 1 (13), so the windows do not merge.
    const file: FileSearchResult = {
      path: '/w/a.ts',
      matches: [
        match(10, 'hit', ['a', 'b'], ['c', 'd']),
        match(16, 'hit', ['e', 'f'], ['g', 'h']),
      ],
    };
    expect(buildExcerpts(file)).toHaveLength(2);
  });

  it('does not attach a trimmed match window highlight to a neighbouring context line carrying the untrimmed text', () => {
    // Match A's `after` context for line 6 carries the FULL, untrimmed line
    // (the backend never trims context lines). Match B IS line 6, and the
    // backend preview-trimmed ITS window around its own match (lineStart:
    // 400). When the two windows merge, the rendered text for line 6 must
    // stay the untrimmed context text, and B's highlight range — which is an
    // offset into B's trimmed window, not into this text — must be dropped,
    // even though it still counts toward matchCount.
    const file: FileSearchResult = {
      path: '/w/a.ts',
      matches: [
        match(5, 'hit-a', [], ['full untrimmed line six']),
        { ...match(6, 'trimmed window'), lineStart: 400, matchStart: 2, matchEnd: 9 },
      ],
    };
    const excerpts = buildExcerpts(file);
    expect(excerpts).toHaveLength(1);
    const line6 = excerpts[0].lines.find((l) => l.lineNumber === 6)!;
    expect(line6.text).toBe('full untrimmed line six');
    expect(line6.matches).toEqual([]);
    expect(excerpts[0].matchCount).toBe(2);
  });

  it('does not attach a trimmed highlight to text supplied by a merged middle window, three windows deep', () => {
    // Same bug, one hop further along a merge chain. A(5) and B(8) merge
    // first; B's OWN `after` context (not a fresh window's context) supplies
    // the full, untrimmed text for line 9. THEN C(9) — whose own match line
    // is 9, preview-trimmed with lineStart: 500 — merges into the combined
    // A+B window. Line 9's rendered text must stay B's untrimmed context
    // text, C's highlight must be dropped (its offsets are into C's trimmed
    // window, not this text), and matchCount must still count all three.
    const file: FileSearchResult = {
      path: '/w/a.ts',
      matches: [
        match(5, 'hit-a', [], ['line6-ctx']),
        match(8, 'hit-b', ['line7-ctx'], ['full untrimmed line nine']),
        { ...match(9, 'trimmed-c-window'), lineStart: 500, matchStart: 2, matchEnd: 9 },
      ],
    };
    const excerpts = buildExcerpts(file);
    expect(excerpts).toHaveLength(1);
    const line9 = excerpts[0].lines.find((l) => l.lineNumber === 9)!;
    expect(line9.text).toBe('full untrimmed line nine');
    expect(line9.matches).toEqual([]);
    expect(excerpts[0].matchCount).toBe(3);
  });
});

describe('excerptId', () => {
  it('is stable for a file and start line', () => {
    expect(excerptId('/w/a.ts', 12)).toBe('/w/a.ts:12');
  });
});
