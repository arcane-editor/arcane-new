import { describe, it, expect } from 'bun:test';
import { applySaveResult } from './save-outcome';
import type { OpenFile } from '../types';

function file(path: string, content: string, isDirty: boolean): OpenFile {
  return { path, name: path.split('/').pop()!, content, isDirty } as OpenFile;
}

/**
 * `saveFile` captures `file.content`, awaits the write, then cleared `isDirty`
 * unconditionally. Anything typed DURING the write — easily hundreds of
 * milliseconds on a large file or a slow disk — was therefore marked saved
 * while never having been written. The file watcher then saw the on-disk
 * change, found the tab "clean", and reloaded it from disk, silently throwing
 * those keystrokes away.
 */
describe('applySaveResult', () => {
  it('marks the tab clean when nothing changed during the write', () => {
    const files = [file('/a.cs', 'hello', true)];
    expect(applySaveResult(files, '/a.cs', 'hello')[0].isDirty).toBe(false);
  });

  it('KEEPS the tab dirty when the buffer moved on during the write', () => {
    const files = [file('/a.cs', 'hello world', true)];
    // 'hello' is what actually reached disk.
    expect(applySaveResult(files, '/a.cs', 'hello')[0].isDirty).toBe(true);
  });

  it('leaves other tabs untouched', () => {
    const files = [file('/a.cs', 'x', true), file('/b.cs', 'y', true)];
    const out = applySaveResult(files, '/a.cs', 'x');
    expect(out[1]).toBe(files[1]);
    expect(out[1].isDirty).toBe(true);
  });

  it('is a no-op for a path that is no longer open', () => {
    const files = [file('/a.cs', 'x', true)];
    expect(applySaveResult(files, '/gone.cs', 'x')).toEqual(files);
  });

  it('handles an empty file correctly', () => {
    const files = [file('/a.cs', '', true)];
    expect(applySaveResult(files, '/a.cs', '')[0].isDirty).toBe(false);
  });
});
