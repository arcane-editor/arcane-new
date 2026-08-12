import { describe, it, expect } from 'bun:test';
import { splitLines } from './file-lines';

describe('splitLines', () => {
  it('splits on LF', () => {
    expect(splitLines('a\nb\nc')).toEqual(['a', 'b', 'c']);
  });

  it('splits on CRLF without leaving carriage returns', () => {
    expect(splitLines('a\r\nb\r\nc')).toEqual(['a', 'b', 'c']);
  });

  it('drops the empty trailing element from a final newline', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
  });

  it('returns a single empty line for empty content', () => {
    expect(splitLines('')).toEqual(['']);
  });
});
