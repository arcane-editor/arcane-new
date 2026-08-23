import { describe, it, expect } from 'bun:test';
import {
  ARCANE_FILE_MIME,
  EDITOR_TAB_MIME,
  parseFileDrag,
  readFileDrag,
  serializeFileDrag,
} from './drag-mime';

/** Minimal stand-in for the parts of DataTransfer these helpers read. */
function dt(entries: Record<string, string>) {
  return {
    types: Object.keys(entries),
    getData: (type: string) => entries[type] ?? '',
  };
}

describe('readFileDrag', () => {
  it('reads the explorer/tab-bar file payload', () => {
    const data = dt({ [ARCANE_FILE_MIME]: serializeFileDrag({ path: '/p/a.ts', isDir: false }) });
    expect(readFileDrag(data)).toEqual({ path: '/p/a.ts', isDir: false });
  });

  /**
   * The tab bar attaches its reorder payload (a bare path) AND a second
   * file payload. A drop zone that only understood the second one was one
   * forgotten `setData` away from silently ignoring every tab drag — and the
   * two sources did drift, which is the bug this exists for. The reorder
   * payload alone is enough to identify the file, so accept it.
   */
  it('falls back to the tab-reorder payload, which is a bare path', () => {
    expect(readFileDrag(dt({ [EDITOR_TAB_MIME]: '/p/b.tsx' }))).toEqual({
      path: '/p/b.tsx',
      isDir: false,
    });
  });

  it('prefers the richer payload when both are present', () => {
    const data = dt({
      [EDITOR_TAB_MIME]: '/p/stale.ts',
      [ARCANE_FILE_MIME]: serializeFileDrag({ path: '/p/real.ts', isDir: false }),
    });
    expect(readFileDrag(data)?.path).toBe('/p/real.ts');
  });

  it('ignores a virtual tab, which names no file on disk', () => {
    for (const p of ['diff://commit/x', 'auth://callback', 'search://results']) {
      expect(readFileDrag(dt({ [EDITOR_TAB_MIME]: p }))).toBeNull();
    }
  });

  it('returns null for an unrelated or malformed drag', () => {
    expect(readFileDrag(dt({ 'text/plain': 'hello' }))).toBeNull();
    expect(readFileDrag(dt({ [ARCANE_FILE_MIME]: 'not json' }))).toBeNull();
    expect(readFileDrag(dt({ [EDITOR_TAB_MIME]: '' }))).toBeNull();
  });
});

describe('parseFileDrag is unchanged', () => {
  it('still round-trips and still rejects malformed payloads', () => {
    expect(parseFileDrag(serializeFileDrag({ path: '/a', isDir: true }))).toEqual({
      path: '/a',
      isDir: true,
    });
    expect(parseFileDrag('{}')).toBeNull();
    expect(parseFileDrag(null)).toBeNull();
  });
});
