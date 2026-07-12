import { describe, expect, test } from 'bun:test';
import { filesToReload } from './open-file-reload';

const file = (path: string, isDirty = false) => ({ path, isDirty });

describe('filesToReload', () => {
  test('reloads an open, clean file whose path changed on disk', () => {
    expect(
      filesToReload([file('/ws/a.ts'), file('/ws/b.ts')], ['/ws/a.ts']),
    ).toEqual(['/ws/a.ts']);
  });

  test('never reloads dirty files (unsaved edits win)', () => {
    expect(filesToReload([file('/ws/a.ts', true)], ['/ws/a.ts'])).toEqual([]);
  });

  test('ignores changed paths that are not open', () => {
    expect(filesToReload([file('/ws/a.ts')], ['/ws/other.ts'])).toEqual([]);
  });

  test('skips virtual diff:// and auth:// tabs', () => {
    expect(
      filesToReload(
        [file('diff://unstaged/a.ts'), file('auth://login')],
        ['diff://unstaged/a.ts', 'auth://login'],
      ),
    ).toEqual([]);
  });

  test('deduplicates repeated changed paths within a burst', () => {
    expect(
      filesToReload([file('/ws/a.ts')], ['/ws/a.ts', '/ws/a.ts', '/ws/a.ts']),
    ).toEqual(['/ws/a.ts']);
  });

  test('multiple open files changed in one burst all reload', () => {
    expect(
      filesToReload(
        [file('/ws/a.ts'), file('/ws/b.ts'), file('/ws/c.ts', true)],
        ['/ws/a.ts', '/ws/b.ts', '/ws/c.ts'],
      ),
    ).toEqual(['/ws/a.ts', '/ws/b.ts']);
  });
});
