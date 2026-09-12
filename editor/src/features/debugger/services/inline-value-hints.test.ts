import { describe, expect, test } from 'bun:test';
import { inlineHints, stripCommentsAndStrings } from './inline-value-hints';
import type { NamedValue } from './inline-value-hints';

function variable(name: string, value: string): NamedValue {
  return { name, value };
}

const SOURCE = [
  'public class Player {',
  '    public int Tick(int delta) {',
  '        int before = Score;',
  '        Score = before + delta;',
  '        return Score;',
  '    }',
  '}',
];

describe('inlineHints', () => {
  test('annotates the lines a variable is used on', () => {
    const hints = inlineHints(SOURCE, [variable('before', '3')], 4);
    expect(hints.map((h) => h.line)).toEqual([3, 4]);
    expect(hints[0].text).toBe('before: 3');
  });

  test('shows several variables on one line', () => {
    const hints = inlineHints(SOURCE, [variable('before', '3'), variable('delta', '2')], 4);
    const line4 = hints.find((h) => h.line === 4);
    expect(line4?.text).toBe('before: 3  delta: 2');
  });

  test('nothing to show without variables', () => {
    expect(inlineHints(SOURCE, [], 4)).toEqual([]);
  });

  /**
   * A substring match would annotate `before` on a line that only mentions
   * `beforeCount`, putting a value next to a variable that is not there.
   */
  test('matches whole identifiers, not substrings', () => {
    const source = ['        int beforeCount = 1;', '        int before = 2;'];
    const hints = inlineHints(source, [variable('before', '2')], 2);
    expect(hints.map((h) => h.line)).toEqual([2]);
  });

  test('an identifier touching punctuation still matches', () => {
    const source = ['        Use(before);', '        map[before] = 1;'];
    const hints = inlineHints(source, [variable('before', '3')], 1);
    expect(hints.map((h) => h.line)).toEqual([1, 2]);
  });

  /** A name in a comment is not a variable being used. */
  test('ignores mentions inside comments', () => {
    const source = ['        // reset before the loop', '        int x = 1;'];
    expect(inlineHints(source, [variable('before', '3')], 2)).toEqual([]);
  });

  test('ignores mentions inside string literals', () => {
    const source = ['        Log("before the jump");'];
    expect(inlineHints(source, [variable('before', '3')], 1)).toEqual([]);
  });

  test('long values are truncated so the line stays readable', () => {
    const long = 'x'.repeat(200);
    const hints = inlineHints(['        int before = 1;'], [variable('before', long)], 1);
    expect(hints[0].text.length).toBeLessThan(60);
    expect(hints[0].text.endsWith('…')).toBe(true);
  });

  test('multi-line values are flattened onto one line', () => {
    const hints = inlineHints(
      ['        int before = 1;'],
      [variable('before', 'a\n  b')],
      1,
    );
    expect(hints[0].text).toBe('before: a b');
  });

  /** Annotating the whole file on every step would be a lot of decorations. */
  test('only annotates near the stopped line', () => {
    const many = Array.from({ length: 400 }, () => '        int before = 1;');
    const hints = inlineHints(many, [variable('before', '3')], 200);
    expect(hints.length).toBeLessThan(200);
    expect(hints.every((h) => Math.abs(h.line - 200) <= 60)).toBe(true);
  });

  test('caps how many variables share a line', () => {
    const source = ['        f(a, b, c, d, e);'];
    const vars = ['a', 'b', 'c', 'd', 'e'].map((n) => variable(n, '1'));
    const hints = inlineHints(source, vars, 1);
    expect(hints[0].text.split('  ').length).toBe(3);
  });

  test('a blank or comment-only line is skipped entirely', () => {
    const source = ['', '   // before', '        int before = 1;'];
    expect(inlineHints(source, [variable('before', '3')], 3).map((h) => h.line)).toEqual([3]);
  });
});

describe('stripCommentsAndStrings', () => {
  test('keeps code and blanks out a trailing comment', () => {
    expect(stripCommentsAndStrings('int x = 1; // set x').trimEnd()).toBe('int x = 1;');
  });

  test('blanks out string contents', () => {
    expect(stripCommentsAndStrings('Log("x = 1");').includes('x = 1')).toBe(false);
  });

  /** An escaped quote does not end the string. */
  test('an escaped quote does not terminate the literal', () => {
    expect(stripCommentsAndStrings('Log("a\\"b"); int y = 1;').includes('y = 1')).toBe(true);
    expect(stripCommentsAndStrings('Log("a\\"b");').includes('a')).toBe(false);
  });

  test('preserves length so columns still line up', () => {
    const text = 'int x = 1; // comment';
    expect(stripCommentsAndStrings(text).length).toBe(text.length);
  });
});
