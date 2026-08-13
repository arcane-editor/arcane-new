import { describe, it, expect } from 'bun:test';
import { insertMatchMarks } from './match-highlight';

const MARK_OPEN = '<mark class="search-match-highlight">';
const MARK_CLOSE = '</mark>';

describe('insertMatchMarks', () => {
  it('wraps a match entirely inside a single span, preserving the class on both halves', () => {
    const html = '<span class="mtk1">hello world</span>';
    expect(insertMatchMarks(html, [{ start: 6, end: 11 }])).toBe(
      '<span class="mtk1">hello </span>' +
        MARK_OPEN +
        '<span class="mtk1">world</span>' +
        MARK_CLOSE,
    );
  });

  it('wraps a whole span among several sibling spans, leaving the others untouched', () => {
    const html =
      '<span class="mtk1">foo</span><span class="mtk2">bar</span><span class="mtk3">baz</span>';
    // "bar" is exactly the second span's text.
    expect(insertMatchMarks(html, [{ start: 3, end: 6 }])).toBe(
      '<span class="mtk1">foo</span>' +
        MARK_OPEN +
        '<span class="mtk2">bar</span>' +
        MARK_CLOSE +
        '<span class="mtk3">baz</span>',
    );
  });

  it('wraps a match spanning two spans in ONE mark, not two adjacent marks', () => {
    const html = '<span class="mtk1">foo</span><span class="mtk2">bar</span>';
    // Covers "oo" (end of span 1) + "ba" (start of span 2).
    expect(insertMatchMarks(html, [{ start: 1, end: 5 }])).toBe(
      '<span class="mtk1">f</span>' +
        MARK_OPEN +
        '<span class="mtk1">oo</span><span class="mtk2">ba</span>' +
        MARK_CLOSE +
        '<span class="mtk2">r</span>',
    );
  });

  it('wraps a match at the very start of the line', () => {
    const html = '<span class="mtk1">const</span><span class="mtk2"> x</span>';
    expect(insertMatchMarks(html, [{ start: 0, end: 5 }])).toBe(
      MARK_OPEN +
        '<span class="mtk1">const</span>' +
        MARK_CLOSE +
        '<span class="mtk2"> x</span>',
    );
  });

  it('wraps a match at the very end of the line', () => {
    const html = '<span class="mtk1">foo</span><span class="mtk2">bar</span>';
    expect(insertMatchMarks(html, [{ start: 3, end: 6 }])).toBe(
      '<span class="mtk1">foo</span>' +
        MARK_OPEN +
        '<span class="mtk2">bar</span>' +
        MARK_CLOSE,
    );
  });

  it('renders adjacent matches as two separate marks, not merged into one', () => {
    const html = '<span class="mtk1">abcd</span>';
    expect(
      insertMatchMarks(html, [
        { start: 0, end: 2 },
        { start: 2, end: 4 },
      ]),
    ).toBe(
      MARK_OPEN +
        '<span class="mtk1">ab</span>' +
        MARK_CLOSE +
        MARK_OPEN +
        '<span class="mtk1">cd</span>' +
        MARK_CLOSE,
    );
  });

  it('drops a zero-width range and returns the input unchanged', () => {
    const html = '<span class="mtk1">hello</span>';
    expect(insertMatchMarks(html, [{ start: 2, end: 2 }])).toBe(html);
  });

  it('drops a range entirely past the end of the text and returns the input unchanged', () => {
    const html = '<span class="mtk1">hi</span>';
    expect(insertMatchMarks(html, [{ start: 10, end: 12 }])).toBe(html);
  });

  it('is a no-op when there are no ranges at all', () => {
    const html = '<span class="mtk1">foo</span><span class="mtk2">bar</span>';
    expect(insertMatchMarks(html, [])).toBe(html);
  });

  it('decodes entities to compute offsets in the real character space, then re-escapes without double-escaping', () => {
    // Source line is `a <b> c` (7 real characters); Monaco's colorize would
    // have escaped it to `a &lt;b&gt; c` inside the span.
    const html = '<span class="mtk1">a &lt;b&gt; c</span>';
    // Matches "<b>" — offsets 2..5 in the DECODED 7-character text, not in
    // the raw (entity-containing) HTML source string.
    expect(insertMatchMarks(html, [{ start: 2, end: 5 }])).toBe(
      '<span class="mtk1">a </span>' +
        MARK_OPEN +
        '<span class="mtk1">&lt;b&gt;</span>' +
        MARK_CLOSE +
        '<span class="mtk1"> c</span>',
    );
  });

  it('handles a single span with no surrounding siblings', () => {
    const html = '<span class="mtk6">TODO</span>';
    expect(insertMatchMarks(html, [{ start: 0, end: 4 }])).toBe(
      MARK_OPEN + '<span class="mtk6">TODO</span>' + MARK_CLOSE,
    );
  });
});
