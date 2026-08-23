import { describe, it, expect } from 'bun:test';
import { PASTE_CHIP_MIN_CHARS, PASTE_CHIP_MIN_LINES, pasteChipLabel, shouldChipPaste } from './paste-chip';

describe('shouldChipPaste', () => {
  /**
   * The point of the threshold is that normal typing-adjacent pastes — a
   * filename, a symbol, a one-line error — keep behaving exactly as they
   * always have. Only a slab big enough to bury the composer becomes a chip.
   */
  it('leaves small pastes alone', () => {
    expect(shouldChipPaste('Foo.tsx')).toBe(false);
    expect(shouldChipPaste('const x = 1;')).toBe(false);
    expect(shouldChipPaste('line1\nline2\nline3')).toBe(false);
    expect(shouldChipPaste('')).toBe(false);
  });

  it('chips a paste with many lines', () => {
    expect(shouldChipPaste('x\n'.repeat(PASTE_CHIP_MIN_LINES))).toBe(true);
  });

  it('chips a long single-line paste', () => {
    expect(shouldChipPaste('x'.repeat(PASTE_CHIP_MIN_CHARS))).toBe(true);
  });

  it('is exclusive at the boundary, so the threshold reads as "more than"', () => {
    expect(shouldChipPaste('x\n'.repeat(PASTE_CHIP_MIN_LINES - 1))).toBe(false);
    expect(shouldChipPaste('x'.repeat(PASTE_CHIP_MIN_CHARS - 1))).toBe(false);
  });

  it('ignores trailing blank lines when counting', () => {
    // A copy out of an editor usually carries a trailing newline; counting it
    // would chip a paste one line shorter than the threshold claims.
    expect(shouldChipPaste('x\n'.repeat(PASTE_CHIP_MIN_LINES - 1) + '\n\n\n')).toBe(false);
  });
});

describe('pasteChipLabel', () => {
  it('counts lines, and says so in the singular when there is one', () => {
    expect(pasteChipLabel('a'.repeat(500))).toBe('Pasted 1 line');
    expect(pasteChipLabel('a\nb\nc')).toBe('Pasted 3 lines');
  });

  it('does not count a trailing newline as another line', () => {
    expect(pasteChipLabel('a\nb\n')).toBe('Pasted 2 lines');
  });
});
