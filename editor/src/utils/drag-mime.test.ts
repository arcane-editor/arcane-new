import { describe, expect, it } from 'bun:test';
import { parseFileDrag, serializeFileDrag } from './drag-mime';

describe('file drag payload', () => {
  it('round-trips a file and a directory', () => {
    const file = { path: '/w/src/index.ts', isDir: false };
    expect(parseFileDrag(serializeFileDrag(file))).toEqual(file);

    const dir = { path: '/w/src', isDir: true };
    expect(parseFileDrag(serializeFileDrag(dir))).toEqual(dir);
  });

  it('returns null for anything malformed rather than throwing', () => {
    // A drop zone reads whatever the OS or another app put on the dataTransfer,
    // so this parses untrusted input on every drop.
    expect(parseFileDrag(null)).toBeNull();
    expect(parseFileDrag(undefined)).toBeNull();
    expect(parseFileDrag('')).toBeNull();
    expect(parseFileDrag('not json')).toBeNull();
    expect(parseFileDrag('[]')).toBeNull();
    expect(parseFileDrag('"a string"')).toBeNull();
    expect(parseFileDrag('null')).toBeNull();
  });

  it('rejects a payload with no usable path', () => {
    expect(parseFileDrag('{"isDir":false}')).toBeNull();
    expect(parseFileDrag('{"path":"","isDir":false}')).toBeNull();
    expect(parseFileDrag('{"path":123}')).toBeNull();
  });

  it('coerces a missing or non-boolean isDir to false', () => {
    expect(parseFileDrag('{"path":"/w/a.ts"}')).toEqual({ path: '/w/a.ts', isDir: false });
    expect(parseFileDrag('{"path":"/w/a.ts","isDir":"yes"}')).toEqual({
      path: '/w/a.ts',
      isDir: false,
    });
  });
});
