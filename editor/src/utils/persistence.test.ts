import { describe, it, expect } from 'bun:test';
import {
  planFileRestore,
  resolveActiveFilePath,
  stripDiffTabSuffix,
  shouldPersistTab,
  type PersistedOpenFile,
} from './persistence';

describe('stripDiffTabSuffix', () => {
  it('strips a "(Staged)" suffix', () => {
    expect(stripDiffTabSuffix('Foo.cs (Staged)')).toBe('Foo.cs');
  });

  it('strips a "(Working Tree)" suffix', () => {
    expect(stripDiffTabSuffix('Foo.cs (Working Tree)')).toBe('Foo.cs');
  });

  it('leaves a name with no diff suffix untouched', () => {
    expect(stripDiffTabSuffix('Foo.cs')).toBe('Foo.cs');
  });

  it('does not touch parentheses that are not the diff suffix', () => {
    expect(stripDiffTabSuffix('Foo (copy).cs')).toBe('Foo (copy).cs');
  });
});

describe('planFileRestore (old shape → new loader migration)', () => {
  it('plans a plain file open for an old-shape entry with no diff field', () => {
    // Entries persisted before the `diff` field existed have exactly this
    // shape — migration must keep restoring them as regular files.
    const entry: PersistedOpenFile = { path: '/proj/Assets/Foo.cs', name: 'Foo.cs' };
    expect(planFileRestore(entry)).toEqual({
      kind: 'file',
      path: '/proj/Assets/Foo.cs',
      name: 'Foo.cs',
    });
  });

  it('plans an openDiffTab call for a staged diff entry, stripping the name suffix', () => {
    const entry: PersistedOpenFile = {
      path: 'diff://staged/Assets/Foo.cs',
      name: 'Foo.cs (Staged)',
      diff: { filePath: 'Assets/Foo.cs', staged: true },
    };
    expect(planFileRestore(entry)).toEqual({
      kind: 'diff',
      filePath: 'Assets/Foo.cs',
      name: 'Foo.cs',
      staged: true,
    });
  });

  it('plans an openDiffTab call for an unstaged (working tree) diff entry', () => {
    const entry: PersistedOpenFile = {
      path: 'diff://unstaged/Assets/Bar.cs',
      name: 'Bar.cs (Working Tree)',
      diff: { filePath: 'Assets/Bar.cs', staged: false },
    };
    expect(planFileRestore(entry)).toEqual({
      kind: 'diff',
      filePath: 'Assets/Bar.cs',
      name: 'Bar.cs',
      staged: false,
    });
  });
});

describe('shouldPersistTab (A4: commit-diff tabs excluded from persistence)', () => {
  it('persists a plain file tab', () => {
    expect(shouldPersistTab('/proj/Assets/Foo.cs')).toBe(true);
  });

  it('persists a staged diff:// tab', () => {
    expect(shouldPersistTab('diff://staged/Assets/Foo.cs')).toBe(true);
  });

  it('persists an unstaged diff:// tab', () => {
    expect(shouldPersistTab('diff://unstaged/Assets/Bar.cs')).toBe(true);
  });

  it('excludes an auth:// virtual tab', () => {
    expect(shouldPersistTab('auth://login')).toBe(false);
  });

  it('excludes a diff://commit/<hash>/<relpath> tab', () => {
    expect(shouldPersistTab('diff://commit/abc1234/Assets/Foo.cs')).toBe(false);
  });

  it('excludes a diff://commit/ tab even when the hash looks like "staged" or "unstaged"', () => {
    // Guards against a naive prefix check that only distinguishes the second
    // path segment — commit tabs must be excluded regardless of hash value.
    expect(shouldPersistTab('diff://commit/staged/Assets/Foo.cs')).toBe(false);
  });
});

describe('resolveActiveFilePath (post-restore active-tab fallback)', () => {
  it('honors the persisted active path when it restored successfully', () => {
    const restored = ['/proj/Assets/Foo.cs', '/proj/Assets/Bar.cs'];
    expect(resolveActiveFilePath('/proj/Assets/Bar.cs', restored)).toBe('/proj/Assets/Bar.cs');
  });

  it('falls back to the last successfully restored path when the active entry failed to restore', () => {
    // e.g. a staged diff tab whose git state changed between sessions, so
    // openDiffTab threw and the entry was skipped — the persisted active
    // path never made it into openFiles.
    const restored = ['/proj/Assets/Foo.cs', '/proj/Assets/Bar.cs'];
    expect(resolveActiveFilePath('diff://staged/Assets/Stale.cs', restored)).toBe('/proj/Assets/Bar.cs');
  });

  it('returns null when nothing restored, so the caller leaves activeFilePath untouched', () => {
    expect(resolveActiveFilePath('/proj/Assets/Foo.cs', [])).toBeNull();
    expect(resolveActiveFilePath(null, [])).toBeNull();
  });
});
