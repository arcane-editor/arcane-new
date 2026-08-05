import { describe, it, expect } from 'bun:test';
import { resolveDiffSources, isLiveDiff, nextDiffInfo } from './diff-sources';
import type { DiffInfo } from '../../../types';

function diff(over: Partial<DiffInfo> = {}): DiffInfo {
  return {
    originalContent: 'a\n',
    modifiedContent: 'b\n',
    filePath: 'src/a.ts',
    staged: false,
    ...over,
  };
}

describe('resolveDiffSources', () => {
  it('diffs a staged edit as HEAD vs index at the same path', () => {
    expect(resolveDiffSources({ path: 'src/a.ts', staged: true })).toEqual({
      original: { from: 'head', path: 'src/a.ts' },
      modified: { from: 'index', path: 'src/a.ts' },
    });
  });

  it('diffs an unstaged edit as index vs worktree at the same path', () => {
    expect(resolveDiffSources({ path: 'src/a.ts', staged: false })).toEqual({
      original: { from: 'index', path: 'src/a.ts' },
      modified: { from: 'worktree', path: 'src/a.ts' },
    });
  });

  it('reads the HEAD side of a staged rename from the PRE-rename path', () => {
    // The whole point: `HEAD:src/new.ts` does not exist, so using it rendered
    // a renamed file as a 100%-added one.
    expect(
      resolveDiffSources({ path: 'src/new.ts', staged: true, origPath: 'src/old.ts' }),
    ).toEqual({
      original: { from: 'head', path: 'src/old.ts' },
      modified: { from: 'index', path: 'src/new.ts' },
    });
  });

  it('ignores origPath for the unstaged side of a rename', () => {
    // A rename's index entry already lives at the new path, so the worktree
    // comparison never involves where the file used to be.
    expect(
      resolveDiffSources({ path: 'src/new.ts', staged: false, origPath: 'src/old.ts' }),
    ).toEqual({
      original: { from: 'index', path: 'src/new.ts' },
      modified: { from: 'worktree', path: 'src/new.ts' },
    });
  });

  it('falls back to the current path when origPath is absent or blank', () => {
    for (const origPath of [undefined, null, '']) {
      expect(resolveDiffSources({ path: 'src/a.ts', staged: true, origPath })).toEqual({
        original: { from: 'head', path: 'src/a.ts' },
        modified: { from: 'index', path: 'src/a.ts' },
      });
    }
  });
});

describe('isLiveDiff', () => {
  it('treats staged and unstaged diffs as refreshable', () => {
    expect(isLiveDiff(diff({ staged: true }))).toBe(true);
    expect(isLiveDiff(diff({ staged: false }))).toBe(true);
  });

  it('excludes commit diffs, which are pinned to immutable revisions', () => {
    expect(isLiveDiff(diff({ commitHash: 'abc1234' }))).toBe(false);
  });
});

describe('nextDiffInfo', () => {
  it('returns the SAME object when content is unchanged', () => {
    // Monaco's DiffEditor compares by identity; a fresh object here would
    // re-render (and reset scroll position) on every unrelated git event.
    const current = diff();
    const result = nextDiffInfo(current, { originalContent: 'a\n', modifiedContent: 'b\n' });
    expect(result).toBe(current);
  });

  it('returns a NEW object when content changed', () => {
    // Equally load-bearing in the other direction: mutating in place renders
    // nothing, because the prop reference never changes.
    const current = diff();
    const result = nextDiffInfo(current, { originalContent: 'a\n', modifiedContent: 'CHANGED\n' });
    expect(result).not.toBe(current);
    expect(result.modifiedContent).toBe('CHANGED\n');
  });

  it('detects a change on either side independently', () => {
    const current = diff();
    expect(nextDiffInfo(current, { originalContent: 'X\n', modifiedContent: 'b\n' })).not.toBe(
      current,
    );
    expect(nextDiffInfo(current, { originalContent: 'a\n', modifiedContent: 'Y\n' })).not.toBe(
      current,
    );
  });

  it('preserves the tab metadata that identifies what is being diffed', () => {
    const current = diff({ staged: true, origPath: 'src/old.ts', semanticCandidate: true });
    const result = nextDiffInfo(current, { originalContent: 'a\n', modifiedContent: 'Z\n' });
    expect(result.filePath).toBe('src/a.ts');
    expect(result.staged).toBe(true);
    // Losing origPath on refresh would turn a rename diff back into a
    // whole-file insertion.
    expect(result.origPath).toBe('src/old.ts');
    expect(result.semanticCandidate).toBe(true);
  });

  it('handles a diff becoming empty (both sides identical after staging)', () => {
    const current = diff({ originalContent: 'a\n', modifiedContent: 'b\n' });
    const result = nextDiffInfo(current, { originalContent: 'b\n', modifiedContent: 'b\n' });
    expect(result).not.toBe(current);
    expect(result.originalContent).toBe('b\n');
  });
});
