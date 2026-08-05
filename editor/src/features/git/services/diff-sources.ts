/**
 * Which git object each side of a working-tree/staged diff should be read
 * from.
 *
 * Split out as a pure function because renames make this genuinely subtle: the
 * two sides of a staged rename live at DIFFERENT paths. `git status` reports
 * only the new path, which by definition does not exist in HEAD — so reading
 * `HEAD:<newPath>` came back empty and the diff rendered a moved file as if
 * every line had been added. The pre-rename path (`orig_path`, from the
 * porcelain record that follows a `2 ` entry) is what HEAD has to be read from.
 */

import type { DiffInfo } from '../../../types';

/** Where one side of a diff comes from. */
export type DiffSide =
  /** `git show HEAD:<path>` — the file as committed. */
  | { from: 'head'; path: string }
  /** `git show :<path>` — the file as staged in the index. */
  | { from: 'index'; path: string }
  /** The file on disk, read relative to the repository root. */
  | { from: 'worktree'; path: string };

export interface DiffSources {
  original: DiffSide;
  modified: DiffSide;
}

export interface DiffSourceInput {
  /** Repo-root-relative path of the file, post-rename if it was renamed. */
  path: string;
  /** Staged (HEAD vs index) rather than unstaged (index vs worktree). */
  staged: boolean;
  /** Pre-rename path, when this entry is a rename/copy. */
  origPath?: string | null;
}

/**
 * Resolve both sides of a diff.
 *
 * - **Staged** compares HEAD against the index. For a rename the HEAD side is
 *   read from `origPath`, so the diff shows what actually changed rather than
 *   a whole-file insertion.
 * - **Unstaged** compares the index against the file on disk. A rename's index
 *   entry already sits at the new path, so both sides use `path` — the
 *   pre-rename path is not involved.
 */
export function resolveDiffSources({ path, staged, origPath }: DiffSourceInput): DiffSources {
  if (staged) {
    return {
      original: { from: 'head', path: origPath || path },
      modified: { from: 'index', path },
    };
  }
  return {
    original: { from: 'index', path },
    modified: { from: 'worktree', path },
  };
}

/**
 * Whether an open diff tab can go stale and so is worth re-reading on a git or
 * filesystem event.
 *
 * Commit diffs are pinned to immutable revisions (`<hash>^` vs `<hash>`), so
 * they never change; staged and unstaged diffs read the index and the working
 * tree, both of which move under the tab.
 */
export function isLiveDiff(diff: DiffInfo): boolean {
  return !diff.commitHash;
}

/**
 * Fold freshly-read content into a diff tab, preserving object identity when
 * nothing actually changed.
 *
 * Both halves of this matter for Monaco's `DiffEditor`, which compares by prop
 * identity: returning the SAME object when content is unchanged stops an
 * unrelated git event from re-rendering the editor and throwing away the
 * user's scroll position, while returning a NEW object when it did change is
 * the only way the editor picks the update up at all — mutating in place
 * renders nothing.
 */
export function nextDiffInfo(
  current: DiffInfo,
  next: { originalContent: string; modifiedContent: string },
): DiffInfo {
  if (
    current.originalContent === next.originalContent &&
    current.modifiedContent === next.modifiedContent
  ) {
    return current;
  }
  return { ...current, ...next };
}
