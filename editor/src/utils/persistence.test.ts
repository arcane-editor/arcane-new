import { describe, it, expect } from 'bun:test';
import {
  migrateRecents,
  migrateWindowEntry,
  planFileRestore,
  resolveActiveFilePath,
  stripDiffTabSuffix,
  shouldPersistTab,
  type PersistedOpenFile,
} from './persistence';
import { hashLabel } from './window-label';

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

describe('migrateRecents (legacy Windows paths in recents.json)', () => {
  it('normalizes a verbatim Windows path and recomputes its degenerate name', () => {
    // The old '/'-splitting basename returned the whole string for a `\\?\`
    // path, so the recents list showed the full path as the project name.
    const out = migrateRecents([
      { path: '\\\\?\\D:\\Unity\\Proj', name: '\\\\?\\D:\\Unity\\Proj', lastOpened: 1 },
    ]);
    expect(out).toEqual([{ path: 'D:/Unity/Proj', name: 'Proj', lastOpened: 1 }]);
  });

  it('drops a legacy entry that collapses onto an already-normalized one', () => {
    const out = migrateRecents([
      { path: 'D:/Unity/Proj', name: 'Proj', lastOpened: 2 },
      { path: '\\\\?\\D:\\Unity\\Proj', name: 'Proj', lastOpened: 1 },
    ]);
    expect(out).toEqual([{ path: 'D:/Unity/Proj', name: 'Proj', lastOpened: 2 }]);
  });

  it('leaves POSIX entries — backslashes included — byte-for-byte alone', () => {
    // A backslash is a legal file-name character on macOS/Linux.
    const entries = [
      { path: '/Users/me/proj', name: 'proj', lastOpened: 3 },
      { path: '/Users/me/we\\ird', name: 'we\\ird', lastOpened: 4 },
    ];
    expect(migrateRecents(entries)).toEqual(entries);
  });

  it('preserves order and does not mutate its input', () => {
    const entries = [
      { path: '\\\\?\\D:\\A', name: 'A', lastOpened: 2 },
      { path: '/Users/me/B', name: 'B', lastOpened: 1 },
    ];
    const out = migrateRecents(entries);
    expect(out.map((r) => r.path)).toEqual(['D:/A', '/Users/me/B']);
    expect(entries[0].path).toBe('\\\\?\\D:\\A');
  });
});

describe('migrateWindowEntry (window-state re-key after path normalization)', () => {
  const legacy = '\\\\?\\D:\\Unity\\Proj';
  const normalized = 'D:/Unity/Proj';

  it('re-keys a project window whose label was hashed from the legacy path', () => {
    // Without this the label changes under the entry and `loadState()` finds
    // nothing — losing every open tab, the active file and the pane widths.
    const { label, state } = migrateWindowEntry(hashLabel(legacy), {
      workspacePath: legacy,
      openFilePaths: [{ path: legacy + '\\Assets\\A.cs', name: legacy + '\\Assets\\A.cs' }],
      activeFilePath: legacy + '\\Assets\\A.cs',
      layoutSizes: { sidebar: 240 },
    });

    expect(label).toBe(hashLabel(normalized));
    expect(state.workspacePath).toBe(normalized);
    expect(state.activeFilePath).toBe('D:/Unity/Proj/Assets/A.cs');
    expect(state.openFilePaths).toEqual([
      { path: 'D:/Unity/Proj/Assets/A.cs', name: 'A.cs' },
    ]);
    expect(state.layoutSizes).toEqual({ sidebar: 240 });
  });

  it('keeps fixed labels ("main", "welcome") even when their paths migrate', () => {
    // Their state is not addressed by project path, so re-keying would move it
    // somewhere the window will never look.
    const { label, state } = migrateWindowEntry('main', {
      workspacePath: legacy,
      openFilePaths: [],
      activeFilePath: null,
    });
    expect(label).toBe('main');
    expect(state.workspacePath).toBe(normalized);
  });

  it('leaves an already-normalized entry untouched', () => {
    const before = {
      workspacePath: normalized,
      openFilePaths: [{ path: 'D:/Unity/Proj/Assets/A.cs', name: 'A.cs' }],
      activeFilePath: 'D:/Unity/Proj/Assets/A.cs',
    };
    const { label, state } = migrateWindowEntry(hashLabel(normalized), before);
    expect(label).toBe(hashLabel(normalized));
    expect(state).toEqual(before);
  });

  it('leaves a POSIX entry untouched', () => {
    const posix = '/Users/me/Unity/Proj';
    const { label, state } = migrateWindowEntry(hashLabel(posix), {
      workspacePath: posix,
      openFilePaths: [],
      activeFilePath: null,
    });
    expect(label).toBe(hashLabel(posix));
    expect(state.workspacePath).toBe(posix);
  });

  it('does not re-key when the label is not the hash of the stored path', () => {
    // Defensive: an entry whose label and workspacePath disagree is not
    // path-addressed state, so moving it would orphan it just as badly.
    const { label } = migrateWindowEntry('editor-deadbeef', {
      workspacePath: legacy,
      openFilePaths: [],
      activeFilePath: null,
    });
    expect(label).toBe('editor-deadbeef');
  });

  it('keeps a null workspacePath on its original label', () => {
    const { label, state } = migrateWindowEntry('main', {
      workspacePath: null,
      openFilePaths: [],
      activeFilePath: null,
    });
    expect(label).toBe('main');
    expect(state.workspacePath).toBeNull();
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
