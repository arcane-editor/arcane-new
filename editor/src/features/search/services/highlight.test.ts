import { describe, it, expect } from 'bun:test';
import { splitByMatches, excerptRowKey } from './highlight';

describe('splitByMatches', () => {
  it('returns one plain segment for a line with no matches', () => {
    expect(splitByMatches('hello', [])).toEqual([{ text: 'hello', isMatch: false }]);
  });

  it('splits around a single match', () => {
    expect(splitByMatches('a hit b', [{ start: 2, end: 5 }])).toEqual([
      { text: 'a ', isMatch: false },
      { text: 'hit', isMatch: true },
      { text: ' b', isMatch: false },
    ]);
  });

  it('splits around two matches on one line', () => {
    expect(splitByMatches('ab cd ab', [{ start: 0, end: 2 }, { start: 6, end: 8 }])).toEqual([
      { text: 'ab', isMatch: true },
      { text: ' cd ', isMatch: false },
      { text: 'ab', isMatch: true },
    ]);
  });

  it('drops zero-width and out-of-range ranges rather than emitting empty spans', () => {
    expect(splitByMatches('abc', [{ start: 1, end: 1 }])).toEqual([
      { text: 'abc', isMatch: false },
    ]);
    expect(splitByMatches('abc', [{ start: 2, end: 99 }])).toEqual([
      { text: 'ab', isMatch: false },
      { text: 'c', isMatch: true },
    ]);
  });

  it('sorts unordered ranges before splitting', () => {
    expect(splitByMatches('ab cd', [{ start: 3, end: 5 }, { start: 0, end: 2 }])).toEqual([
      { text: 'ab', isMatch: true },
      { text: ' ', isMatch: false },
      { text: 'cd', isMatch: true },
    ]);
  });

  // This is the actual upstream failure mode `splitByMatches` exists to
  // survive: two matches on one long line, one of them describing a window
  // that runs past the rendered text's length. A single out-of-range range
  // (covered above) doesn't exercise the "sort, then clamp, then keep
  // walking past it" path the same way a second, in-range range does.
  it('clamps a wildly out-of-range end without losing a later in-range match', () => {
    expect(splitByMatches('ab cd', [{ start: 0, end: 2 }, { start: 3, end: 500 }])).toEqual([
      { text: 'ab', isMatch: true },
      { text: ' ', isMatch: false },
      { text: 'cd', isMatch: true },
    ]);
  });
});

describe('excerptRowKey', () => {
  it('formats as filePath#lineNumber', () => {
    expect(excerptRowKey('/w/a.ts', 12)).toBe('/w/a.ts#12');
  });

  // The obvious version of this test just re-checks the format above under a
  // "uniqueness" label, which would pass even for a function that ignores
  // one of its arguments. Actually vary file and line independently.
  it('is unique per file and line', () => {
    const a = excerptRowKey('/w/a.ts', 12);
    const b = excerptRowKey('/w/b.ts', 12);
    const c = excerptRowKey('/w/a.ts', 13);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });
});
