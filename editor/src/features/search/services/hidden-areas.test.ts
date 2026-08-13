import { describe, it, expect } from 'bun:test';
import { complementRanges, canHideAreas, applyHiddenAreas } from './hidden-areas';

describe('complementRanges', () => {
  it('hides everything outside a single excerpt', () => {
    expect(complementRanges([{ start: 10, end: 14 }], 100)).toEqual([
      { start: 1, end: 9 },
      { start: 15, end: 100 },
    ]);
  });

  it('hides the gap between two excerpts', () => {
    expect(complementRanges([{ start: 10, end: 12 }, { start: 40, end: 42 }], 50)).toEqual([
      { start: 1, end: 9 },
      { start: 13, end: 39 },
      { start: 43, end: 50 },
    ]);
  });

  it('emits no leading range when an excerpt starts at line 1', () => {
    expect(complementRanges([{ start: 1, end: 5 }], 20)).toEqual([{ start: 6, end: 20 }]);
  });

  it('emits no trailing range when an excerpt ends at the last line', () => {
    expect(complementRanges([{ start: 16, end: 20 }], 20)).toEqual([{ start: 1, end: 15 }]);
  });

  it('hides nothing when one excerpt covers the whole file', () => {
    expect(complementRanges([{ start: 1, end: 20 }], 20)).toEqual([]);
  });

  it('hides the whole file when there are no excerpts', () => {
    expect(complementRanges([], 20)).toEqual([{ start: 1, end: 20 }]);
  });

  it('merges touching excerpts rather than emitting an empty hidden range', () => {
    expect(complementRanges([{ start: 5, end: 9 }, { start: 10, end: 12 }], 20)).toEqual([
      { start: 1, end: 4 },
      { start: 13, end: 20 },
    ]);
  });
});

describe('canHideAreas', () => {
  it('is false for an editor without the internal API', () => {
    expect(canHideAreas({})).toBe(false);
  });

  it('is false for null', () => {
    expect(canHideAreas(null)).toBe(false);
  });

  it('is true when setHiddenAreas is callable', () => {
    expect(canHideAreas({ setHiddenAreas: () => {} })).toBe(true);
  });

  it('is false when setHiddenAreas is present but not a function', () => {
    // Guards against a property-existence check (`'setHiddenAreas' in editor`)
    // standing in for a type check — such a check would pass every test above
    // yet let a non-callable property through here.
    expect(canHideAreas({ setHiddenAreas: 'nope' })).toBe(false);
  });
});

describe('applyHiddenAreas', () => {
  it('passes Monaco range literals for the complement and reports success', () => {
    const calls: unknown[][] = [];
    const editor = { setHiddenAreas: (ranges: unknown[]) => calls.push(ranges) };
    expect(applyHiddenAreas(editor, [{ start: 10, end: 12 }], 20)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      { startLineNumber: 1, startColumn: 1, endLineNumber: 9, endColumn: 1 },
      { startLineNumber: 13, startColumn: 1, endLineNumber: 20, endColumn: 1 },
    ]);
  });

  it('reports failure and does not throw when the API is missing', () => {
    expect(applyHiddenAreas({}, [{ start: 1, end: 2 }], 20)).toBe(false);
  });

  it('still calls setHiddenAreas with an empty array when the whole file is visible', () => {
    // A previous excerpt may have hidden lines; if applyHiddenAreas skipped
    // the call whenever there is nothing left to hide, those areas would
    // stay hidden instead of being cleared.
    const calls: unknown[][] = [];
    const editor = { setHiddenAreas: (ranges: unknown[]) => calls.push(ranges) };
    expect(applyHiddenAreas(editor, [{ start: 1, end: 20 }], 20)).toBe(true);
    expect(calls).toEqual([[]]);
  });
});
