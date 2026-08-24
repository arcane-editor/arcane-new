import { describe, it, expect } from 'bun:test';
import { truncateHead, truncateTail, DEFAULT_MAX_BYTES } from './truncate';

// The bash tool shows the TAIL of a command's output. A single line longer than
// the byte cap is ordinary in this app (a minified bundle, a one-line JSON dump,
// a Unity log written without newlines) — and it used to reach the model as an
// EMPTY string flagged `truncated: true`, because the backwards scan found no
// whole line that fit and `lines.slice(lines.length)` is `[]`. An empty tool
// result reads to the model as "the command produced no output", which is a lie
// about the one case where the output was the largest.
describe('truncateTail — oversized single line', () => {
  it('returns the tail of an over-cap last line instead of nothing', () => {
    const huge = 'x'.repeat(DEFAULT_MAX_BYTES * 2);
    const r = truncateTail(huge);

    expect(r.content.length).toBeGreaterThan(0);
    expect(r.truncated).toBe(true);
    expect(r.truncatedBy).toBe('bytes');
    expect(r.outputBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    // It is the TAIL that is kept — the end of the output is what the bash tool
    // exists to show (exit messages, the last stack frame, the final error).
    expect(huge.endsWith(r.content)).toBe(true);
  });

  it('keeps the last line when an EARLIER line is the oversized one', () => {
    const content = ['a'.repeat(DEFAULT_MAX_BYTES * 2), 'the last line'].join('\n');
    const r = truncateTail(content);

    expect(r.content).toContain('the last line');
    expect(r.outputBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
  });

  it('never splits a multi-byte character when slicing an oversized line', () => {
    // '★' is 3 bytes in UTF-8; a naive byte slice lands mid-character and
    // produces U+FFFD, which is corruption the model cannot tell from real text.
    const huge = '★'.repeat(DEFAULT_MAX_BYTES);
    const r = truncateTail(huge);

    expect(r.content).not.toContain('�');
    expect(new TextEncoder().encode(r.content).length).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
  });
});

// truncateHead already had the `Math.max(lineCount, 1)` floor; these pin it so a
// future refactor can't quietly regress the read tool to the same empty result.
describe('truncateHead — oversized single line', () => {
  it('returns the head of an over-cap single line instead of nothing', () => {
    const huge = 'y'.repeat(DEFAULT_MAX_BYTES * 2);
    const r = truncateHead(huge);

    expect(r.content.length).toBeGreaterThan(0);
    expect(r.truncated).toBe(true);
    expect(r.outputBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(huge.startsWith(r.content)).toBe(true);
  });
});
