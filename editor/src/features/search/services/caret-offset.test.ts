import { describe, it, expect } from 'bun:test';
import { offsetWithinLine, columnFor } from './caret-offset';

describe('offsetWithinLine', () => {
  // A result line renders as several text nodes: plain spans, <mark> for each
  // match, and Monaco's token spans on colourized context lines.
  const nodes = ['const ', 'transform', '.position'];

  it('sums the lengths of every node before the hit node', () => {
    expect(offsetWithinLine(nodes, 1, 4)).toBe(10);
  });

  it('returns the raw offset when the hit is in the first node', () => {
    expect(offsetWithinLine(nodes, 0, 3)).toBe(3);
  });

  it('handles a hit at the very start', () => {
    expect(offsetWithinLine(nodes, 0, 0)).toBe(0);
  });

  it('handles a hit at the end of the last node', () => {
    expect(offsetWithinLine(nodes, 2, 9)).toBe(24);
  });

  it('clamps a node index past the end rather than returning NaN', () => {
    expect(offsetWithinLine(nodes, 99, 0)).toBe(24);
  });

  it('clamps a negative offset to 0', () => {
    expect(offsetWithinLine(nodes, 1, -5)).toBe(6);
  });

  it('returns 0 for an empty line', () => {
    expect(offsetWithinLine([], 0, 0)).toBe(0);
  });

  // The brief's suite never exercises an offset that overshoots its OWN
  // node's length while the node index stays valid — every case above either
  // stays within bounds or pushes the node index itself out of range. A
  // version that clamped only the top-level total (via the nodeIndex >=
  // texts.length branch) but forgot to clamp `nodeOffset` against the hit
  // node's own length would still pass all seven tests above while returning
  // 106 here instead of 6.
  it('clamps an offset that overshoots its own node without inflating the total', () => {
    expect(offsetWithinLine(nodes, 0, 100)).toBe(6);
  });

  // Likewise, nothing above sends a negative node index, so a naive `texts[i]`
  // walk (`for (let i = 0; i < nodeIndex; i++)`) that never clamped the lower
  // bound would just skip its loop for a negative index and silently return
  // the wrong thing — this pins the documented "clamp, never NaN" contract to
  // the low end, not just the high end already covered above.
  it('clamps a negative node index to the first node rather than misreading it', () => {
    expect(offsetWithinLine(nodes, -1, 3)).toBe(3);
  });
});

describe('columnFor', () => {
  it('is 1-based and adds the excerpt window origin', () => {
    expect(columnFor(0, 0)).toBe(1);
    expect(columnFor(0, 7)).toBe(8);
  });

  it('offsets by lineStart so a preview-trimmed line lands correctly', () => {
    // The backend trimmed this line to a window starting at char 400, so an
    // offset of 12 within the rendered text is column 413 in the real file.
    expect(columnFor(400, 12)).toBe(413);
  });
});
