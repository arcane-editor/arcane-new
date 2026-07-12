import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { GitLogEntry, WorktreeInfo, BlameLine, CommitDetail, StashEntry } from '../types';
import { notify } from './notifications';
import { useWorkspaceStore } from './workspace';
import { remoteErrorMessage } from '../utils/remote-errors';
import { singleFlightWithRerun } from '../utils/single-flight';

interface BlameEntry {
  gen: number;
  lines: BlameLine[];
}

export interface GitFileStatus {
  path: string;
  absolute_path: string;
  status: string;
  staged: boolean;
  /** True for an unmerged (conflicted) path. */
  conflicted?: boolean;
}

interface GitStatusResult {
  branch: string;
  staged: GitFileStatus[];
  unstaged: GitFileStatus[];
  ahead: number;
  behind: number;
}

/**
 * Result of the `git_push` command. `set_upstream` is `true` only when the
 * plain push failed with "no upstream branch" and the backend transparently
 * retried as `push -u origin <branch>` — used to show a "pushed and set
 * upstream" toast instead of a plain "pushed" one.
 */
interface GitPushResult {
  stdout: string;
  set_upstream: boolean;
}

interface GitState {
  branch: string | null;
  branches: string[];
  isBranchesLoading: boolean;
  stagedFiles: GitFileStatus[];
  unstagedFiles: GitFileStatus[];
  commitMessage: string;
  /** When true, the next `commit()` call rewrites HEAD (`--amend`) instead of creating a new commit. */
  amendMode: boolean;
  isLoading: boolean;
  isGitRepo: boolean;
  ahead: number;
  behind: number;
  commitLog: GitLogEntry[];
  isRemoteLoading: boolean;
  lastError: string | null;

  worktrees: WorktreeInfo[];
  isLoadingWorktrees: boolean;
  stashes: StashEntry[];
  blameGen: number;
  blameCache: Map<string, BlameEntry>;
  inflightBlame: Map<string, Promise<BlameLine[]>>;

  /** Fetch-once cache of per-commit detail (metadata + changed files), keyed by hash. */
  commitDetails: Map<string, CommitDetail>;
  inflightCommitDetails: Map<string, Promise<CommitDetail | null>>;

  refreshStatus: (workspacePath: string) => Promise<void>;
  refreshBranches: (workspacePath: string) => Promise<void>;
  refreshLog: (workspacePath: string) => Promise<void>;
  switchBranch: (workspacePath: string, branch: string) => Promise<void>;
  createBranch: (
    workspacePath: string,
    name: string,
    opts?: { base?: string; checkout?: boolean },
  ) => Promise<void>;
  renameBranch: (workspacePath: string, oldName: string, newName: string) => Promise<void>;
  deleteBranch: (workspacePath: string, name: string, force?: boolean) => Promise<void>;
  stageFile: (workspacePath: string, filePath: string) => Promise<void>;
  unstageFile: (workspacePath: string, filePath: string) => Promise<void>;
  stageAll: (workspacePath: string) => Promise<void>;
  unstageAll: (workspacePath: string) => Promise<void>;
  discardFile: (workspacePath: string, filePath: string, isUntracked: boolean) => Promise<void>;
  discardAll: (workspacePath: string) => Promise<void>;
  commit: (workspacePath: string) => Promise<void>;
  setCommitMessage: (message: string) => void;
  /**
   * Toggle amend mode. Enabling it while `commitMessage` is empty prefills
   * from the latest commit's message (`commitLog[0]?.message`) so the commit
   * button isn't left disabled by the empty-message guard.
   */
  setAmendMode: (amend: boolean) => void;

  // Unity-aware (F-9)
  /** Resolve a conflicted Unity YAML file via the UnityYAMLMerge tool. */
  runUnityYamlMerge: (workspacePath: string, toolPath: string, filePath: string) => Promise<void>;
  /** Resolve a conflict by taking one side wholesale. */
  resolveConflictSide: (workspacePath: string, filePath: string, side: 'ours' | 'theirs') => Promise<void>;
  /** Append missing lines to .gitignore; returns the lines actually added. */
  appendGitignore: (workspacePath: string, lines: string[]) => Promise<string[]>;
  fetch: (workspacePath: string) => Promise<void>;
  pull: (workspacePath: string) => Promise<void>;
  push: (workspacePath: string) => Promise<void>;
  getFileStatus: (absolutePath: string) => GitFileStatus | undefined;
  clearError: () => void;
  reset: () => void;

  refreshWorktrees: (workspacePath: string) => Promise<void>;
  addWorktree: (
    workspacePath: string,
    args: { path: string; branch?: string; newBranch?: string; force?: boolean }
  ) => Promise<void>;
  removeWorktree: (workspacePath: string, path: string, force?: boolean) => Promise<void>;
  pruneWorktrees: (workspacePath: string) => Promise<void>;

  refreshStashes: (workspacePath: string) => Promise<void>;
  stashPush: (workspacePath: string, message?: string, includeUntracked?: boolean) => Promise<void>;
  stashApply: (workspacePath: string, index: number) => Promise<void>;
  stashPop: (workspacePath: string, index: number) => Promise<void>;
  stashDrop: (workspacePath: string, index: number) => Promise<void>;

  getBlame: (workspacePath: string, absolutePath: string) => Promise<BlameLine[]>;
  invalidateBlameAll: () => void;
  invalidateBlameFile: (absolutePath: string) => void;

  /**
   * Fetch a commit's detail (metadata + changed files) via `git_show_commit`,
   * caching the result forever (commits are immutable, so — unlike blame —
   * there's no invalidation path). Concurrent calls for the same hash
   * collapse onto a single in-flight request. Returns `null` on failure
   * (already surfaced via `notify.error`) so callers can render an empty
   * state rather than throwing.
   */
  getCommitDetail: (workspacePath: string, hash: string) => Promise<CommitDetail | null>;
}

/**
 * Shared post-checkout reload flow used by both `switchBranch` and
 * `createBranch` (when `checkout: true`): invalidate blame, refresh git
 * status, reload any open non-dirty files from disk (the checkout likely
 * changed their content on disk), refresh the file tree, and warn about any
 * dirty files that were skipped to avoid clobbering unsaved work.
 */
async function reloadAfterCheckout(
  get: () => GitState,
  workspacePath: string,
  branchLabel: string,
) {
  get().invalidateBlameAll();
  await get().refreshStatus(workspacePath);

  const ws = useWorkspaceStore.getState();
  const reloadable = ws.openFiles.filter(
    (f) =>
      !f.isDirty &&
      !f.path.startsWith('diff://') &&
      !f.path.startsWith('auth://'),
  );
  const skippedDirty = ws.openFiles.filter(
    (f) => f.isDirty && !f.path.startsWith('diff://') && !f.path.startsWith('auth://'),
  );

  await Promise.all(reloadable.map((f) => ws.reloadFileFromDisk(f.path)));
  await ws.refreshTree();

  if (skippedDirty.length > 0) {
    notify.warning(
      `Switched to ${branchLabel}. ${skippedDirty.length} file${skippedDirty.length === 1 ? '' : 's'} with unsaved changes were not reloaded.`,
    );
  }
}

/**
 * Body of `refreshStatus`, extracted so it can be wrapped in
 * `singleFlightWithRerun` below: the Rust file watcher now emits
 * `git-state-changed` on every settled burst of workspace edits, so
 * `refreshStatus` can be invoked in rapid succession. Without coalescing,
 * overlapping `git status` invocations waste work and can apply results out
 * of order (a slow earlier call resolving after a faster later one).
 *
 * Error classification: a "not a git repository" failure is the expected
 * shape when a workspace isn't (or is no longer) a git repo, so it silently
 * blanks the panel exactly as before. Any OTHER error (a transient git
 * failure, a permissions issue, etc.) is not treated as "not a repo" — the
 * existing lists stay on screen, `isGitRepo` is left alone, and the failure
 * is surfaced via `lastError` (rendered as a banner in SourceControlPanel)
 * plus a console.error for diagnosability.
 */
async function doRefreshStatus(
  workspacePath: string,
  set: (partial: Partial<GitState>) => void,
  get: () => GitState,
) {
  try {
    set({ isLoading: true });
    const result = await invoke<GitStatusResult>('git_status', { workspacePath });
    set({
      branch: result.branch,
      stagedFiles: result.staged,
      unstagedFiles: result.unstaged,
      ahead: result.ahead,
      behind: result.behind,
      isGitRepo: true,
      isLoading: false,
      lastError: null,
    });
    // Also refresh log in background
    get().refreshLog(workspacePath);
  } catch (err) {
    if (String(err).includes('not a git repository')) {
      set({
        branch: null,
        branches: [],
        stagedFiles: [],
        unstagedFiles: [],
        ahead: 0,
        behind: 0,
        isGitRepo: false,
        isLoading: false,
        lastError: null,
      });
    } else {
      set({ isLoading: false, lastError: `git status failed: ${err}` });
      console.error('[git] status refresh failed:', err);
    }
  }
}

/**
 * Body of `refreshBranches`, extracted so it can be wrapped in
 * `singleFlightWithRerun` below — same rationale as `doRefreshStatus`: the
 * `git-state-changed` watcher event calls `refreshStatus` AND
 * `refreshBranches` on every settled burst of workspace edits (see
 * `stores/workspace.ts`), so overlapping `git branch` invocations need
 * coalescing too.
 */
async function doRefreshBranches(
  workspacePath: string,
  set: (partial: Partial<GitState>) => void,
) {
  // Note: `branches` is intentionally left untouched until the fetch
  // resolves — stale branches stay on screen (no flash to empty) while
  // this refresh runs in the background. Consumers gate a "Loading…"
  // affordance on `branches.length === 0 && isBranchesLoading`.
  set({ isBranchesLoading: true });
  try {
    const branches = await invoke<string[]>('git_list_branches', { workspacePath });
    set({ branches });
  } catch (err) {
    console.error('[git] refreshBranches failed:', err);
    set({ branches: [] });
  } finally {
    set({ isBranchesLoading: false });
  }
}

/**
 * Body of `refreshLog`, extracted so it can be wrapped in
 * `singleFlightWithRerun` below — `doRefreshStatus` triggers this in the
 * background on every call, so it inherits the same coalescing need as
 * `refreshStatus`/`refreshBranches` on the `git-state-changed` event path.
 */
async function doRefreshLog(
  workspacePath: string,
  set: (partial: Partial<GitState>) => void,
) {
  try {
    const entries = await invoke<GitLogEntry[]>('git_log', { workspacePath });
    set({ commitLog: entries });
  } catch (err) {
    console.error('[git] refreshLog failed:', err);
    set({ commitLog: [] });
  }
}

export const useGitStore = create<GitState>((set, get) => ({
  branch: null,
  branches: [],
  isBranchesLoading: false,
  stagedFiles: [],
  unstagedFiles: [],
  commitMessage: '',
  amendMode: false,
  isLoading: false,
  isGitRepo: false,
  ahead: 0,
  behind: 0,
  commitLog: [],
  isRemoteLoading: false,
  lastError: null,

  worktrees: [],
  isLoadingWorktrees: false,
  stashes: [],
  blameGen: 0,
  blameCache: new Map(),
  inflightBlame: new Map(),
  commitDetails: new Map(),
  inflightCommitDetails: new Map(),

  refreshStatus: singleFlightWithRerun((workspacePath: string) =>
    doRefreshStatus(workspacePath, set, get),
  ),

  refreshBranches: singleFlightWithRerun((workspacePath: string) =>
    doRefreshBranches(workspacePath, set),
  ),

  refreshLog: singleFlightWithRerun((workspacePath: string) =>
    doRefreshLog(workspacePath, set),
  ),

  switchBranch: async (workspacePath: string, branch: string) => {
    try {
      await invoke('git_switch_branch', { workspacePath, branch });
      await reloadAfterCheckout(get, workspacePath, branch);
    } catch (err) {
      notify.error(`Failed to switch branch: ${err}`);
      throw err;
    }
  },

  createBranch: async (workspacePath, name, opts) => {
    const checkout = opts?.checkout ?? false;
    try {
      await invoke('git_create_branch', {
        workspacePath,
        name,
        base: opts?.base ?? null,
        checkout,
      });
      if (checkout) {
        await reloadAfterCheckout(get, workspacePath, name);
      }
      await get().refreshBranches(workspacePath);
    } catch (err) {
      notify.error(`Failed to create branch: ${err}`);
      throw err;
    }
  },

  renameBranch: async (workspacePath, oldName, newName) => {
    try {
      await invoke('git_rename_branch', { workspacePath, oldName, newName });
      await get().refreshBranches(workspacePath);
      await get().refreshStatus(workspacePath);
    } catch (err) {
      notify.error(`Failed to rename branch: ${err}`);
      throw err;
    }
  },

  deleteBranch: async (workspacePath, name, force) => {
    try {
      await invoke('git_delete_branch', { workspacePath, name, force: force ?? false });
      await get().refreshBranches(workspacePath);
    } catch (err) {
      if (String(err).includes('not fully merged')) {
        notify.error(
          `Failed to delete branch: ${err}. Retry with force delete to discard its commits.`,
        );
      } else {
        notify.error(`Failed to delete branch: ${err}`);
      }
      throw err;
    }
  },

  stageFile: async (workspacePath: string, filePath: string) => {
    try {
      await invoke('git_stage_file', { workspacePath, filePath });
      await get().refreshStatus(workspacePath);
    } catch (err) {
      notify.error(`Failed to stage ${filePath}: ${err}`);
      throw err;
    }
  },

  unstageFile: async (workspacePath: string, filePath: string) => {
    try {
      await invoke('git_unstage_file', { workspacePath, filePath });
      await get().refreshStatus(workspacePath);
    } catch (err) {
      notify.error(`Failed to unstage ${filePath}: ${err}`);
      throw err;
    }
  },

  stageAll: async (workspacePath: string) => {
    try {
      await invoke('git_stage_all', { workspacePath });
      await get().refreshStatus(workspacePath);
    } catch (err) {
      notify.error(`Failed to stage all: ${err}`);
      throw err;
    }
  },

  unstageAll: async (workspacePath: string) => {
    try {
      await invoke('git_unstage_all', { workspacePath });
      await get().refreshStatus(workspacePath);
    } catch (err) {
      notify.error(`Failed to unstage all: ${err}`);
      throw err;
    }
  },

  discardFile: async (workspacePath: string, filePath: string, isUntracked: boolean) => {
    try {
      await invoke('git_discard_file', { workspacePath, filePath, isUntracked });
      get().invalidateBlameAll();
      await get().refreshStatus(workspacePath);
    } catch (err) {
      notify.error(`Failed to discard ${filePath}: ${err}`);
      throw err;
    }
  },

  discardAll: async (workspacePath: string) => {
    try {
      await invoke('git_discard_all', { workspacePath });
      get().invalidateBlameAll();
      await get().refreshStatus(workspacePath);
    } catch (err) {
      notify.error(`Failed to discard all: ${err}`);
      throw err;
    }
  },

  commit: async (workspacePath: string) => {
    const { commitMessage, amendMode } = get();
    if (!commitMessage.trim()) return;
    try {
      await invoke('git_commit', { workspacePath, message: commitMessage, amend: amendMode });
      set({ commitMessage: '', amendMode: false });
      get().invalidateBlameAll();
      notify.success(amendMode ? 'Amended commit on ' + get().branch : 'Committed to ' + get().branch);
      await get().refreshStatus(workspacePath);
    } catch (err) {
      notify.error(`Commit failed: ${err}`);
      throw err;
    }
  },

  setCommitMessage: (message: string) => set({ commitMessage: message }),

  setAmendMode: (amend: boolean) => {
    if (amend) {
      const { commitMessage, commitLog } = get();
      if (!commitMessage.trim() && commitLog[0]?.message) {
        set({ amendMode: true, commitMessage: commitLog[0].message });
        return;
      }
    }
    set({ amendMode: amend });
  },

  runUnityYamlMerge: async (workspacePath, toolPath, filePath) => {
    try {
      await invoke('git_run_unityyamlmerge', { workspacePath, toolPath, filePath });
      notify.success(`Resolved ${filePath.split('/').pop()} with UnityYAMLMerge`);
      await get().refreshStatus(workspacePath);
    } catch (err) {
      notify.error(`UnityYAMLMerge failed: ${err}`);
      throw err;
    }
  },

  resolveConflictSide: async (workspacePath, filePath, side) => {
    try {
      await invoke('git_resolve_conflict_side', { workspacePath, filePath, side });
      await get().refreshStatus(workspacePath);
    } catch (err) {
      notify.error(`Resolve (${side}) failed: ${err}`);
      throw err;
    }
  },

  appendGitignore: async (workspacePath, lines) => {
    try {
      const added = await invoke<string[]>('git_append_gitignore', { workspacePath, lines });
      if (added.length > 0) await get().refreshStatus(workspacePath);
      return added;
    } catch (err) {
      notify.error(`.gitignore update failed: ${err}`);
      return [];
    }
  },

  fetch: async (workspacePath: string) => {
    set({ isRemoteLoading: true, lastError: null });
    try {
      await invoke<string>('git_fetch', { workspacePath });
      await get().refreshStatus(workspacePath);
      notify.success('Fetch completed');
    } catch (err) {
      const message = remoteErrorMessage('Fetch', String(err));
      set({ lastError: message });
      notify.error(message);
    } finally {
      set({ isRemoteLoading: false });
    }
  },

  pull: async (workspacePath: string) => {
    set({ isRemoteLoading: true, lastError: null });
    try {
      await invoke<string>('git_pull', { workspacePath });
      get().invalidateBlameAll();
      await get().refreshStatus(workspacePath);
      notify.success('Changes pulled successfully');
    } catch (err) {
      const message = remoteErrorMessage('Pull', String(err));
      set({ lastError: message });
      notify.error(message);
    } finally {
      set({ isRemoteLoading: false });
    }
  },

  push: async (workspacePath: string) => {
    set({ isRemoteLoading: true, lastError: null });
    try {
      const result = await invoke<GitPushResult>('git_push', { workspacePath });
      await get().refreshStatus(workspacePath);
      notify.success(result.set_upstream ? 'Pushed and set upstream' : 'Changes pushed successfully');
    } catch (err) {
      const message = remoteErrorMessage('Push', String(err));
      set({ lastError: message });
      notify.error(message);
    } finally {
      set({ isRemoteLoading: false });
    }
  },

  getFileStatus: (absolutePath: string) => {
    const { stagedFiles, unstagedFiles } = get();
    return (
      unstagedFiles.find((f) => f.absolute_path === absolutePath) ??
      stagedFiles.find((f) => f.absolute_path === absolutePath)
    );
  },

  clearError: () => set({ lastError: null }),

  reset: () => set({
    branch: null,
    branches: [],
    isBranchesLoading: false,
    stagedFiles: [],
    unstagedFiles: [],
    commitMessage: '',
    amendMode: false,
    isLoading: false,
    isGitRepo: false,
    ahead: 0,
    behind: 0,
    commitLog: [],
    isRemoteLoading: false,
    lastError: null,
    worktrees: [],
    isLoadingWorktrees: false,
    stashes: [],
    blameGen: 0,
    blameCache: new Map(),
    inflightBlame: new Map(),
    commitDetails: new Map(),
    inflightCommitDetails: new Map(),
  }),

  refreshWorktrees: async (workspacePath: string) => {
    set({ isLoadingWorktrees: true });
    try {
      const worktrees = await invoke<WorktreeInfo[]>('git_worktree_list', { workspacePath });
      set({ worktrees, isLoadingWorktrees: false });
    } catch (err) {
      console.error('[git] refreshWorktrees failed:', err);
      set({ worktrees: [], isLoadingWorktrees: false });
    }
  },

  addWorktree: async (workspacePath, args) => {
    try {
      await invoke('git_worktree_add', {
        workspacePath,
        path: args.path,
        branch: args.branch ?? null,
        newBranch: args.newBranch ?? null,
        force: args.force ?? false,
      });
      await get().refreshWorktrees(workspacePath);
      notify.success('Worktree created');
    } catch (err) {
      notify.error(`Add worktree failed: ${err}`);
      throw err;
    }
  },

  removeWorktree: async (workspacePath, path, force) => {
    try {
      await invoke('git_worktree_remove', { workspacePath, path, force: force ?? false });
      await get().refreshWorktrees(workspacePath);
    } catch (err) {
      notify.error(`Remove worktree failed: ${err}`);
      throw err;
    }
  },

  pruneWorktrees: async (workspacePath) => {
    try {
      await invoke('git_worktree_prune', { workspacePath });
      await get().refreshWorktrees(workspacePath);
      notify.success('Worktrees pruned');
    } catch (err) {
      notify.error(`Prune worktrees failed: ${err}`);
      throw err;
    }
  },

  refreshStashes: async (workspacePath: string) => {
    try {
      const stashes = await invoke<StashEntry[]>('git_stash_list', { workspacePath });
      set({ stashes });
    } catch (err) {
      console.error('[git] refreshStashes failed:', err);
      set({ stashes: [] });
    }
  },

  stashPush: async (workspacePath, message, includeUntracked = true) => {
    try {
      await invoke('git_stash_push', {
        workspacePath,
        message: message ?? null,
        includeUntracked,
      });
      await get().refreshStashes(workspacePath);
      await get().refreshStatus(workspacePath);
      get().invalidateBlameAll();
      notify.success('Changes stashed');
    } catch (err) {
      notify.error(`Stash failed: ${err}`);
      throw err;
    }
  },

  stashApply: async (workspacePath, index) => {
    try {
      await invoke('git_stash_apply', { workspacePath, index });
      await get().refreshStashes(workspacePath);
      await get().refreshStatus(workspacePath);
      get().invalidateBlameAll();
      notify.success('Stash applied');
    } catch (err) {
      notify.error(`Stash apply failed: ${err}`);
      throw err;
    }
  },

  stashPop: async (workspacePath, index) => {
    try {
      await invoke('git_stash_pop', { workspacePath, index });
      await get().refreshStashes(workspacePath);
      await get().refreshStatus(workspacePath);
      get().invalidateBlameAll();
      notify.success('Stash popped');
    } catch (err) {
      notify.error(`Stash pop failed: ${err}`);
      throw err;
    }
  },

  stashDrop: async (workspacePath, index) => {
    try {
      await invoke('git_stash_drop', { workspacePath, index });
      await get().refreshStashes(workspacePath);
      await get().refreshStatus(workspacePath);
      get().invalidateBlameAll();
      notify.success('Stash dropped');
    } catch (err) {
      notify.error(`Stash drop failed: ${err}`);
      throw err;
    }
  },

  getBlame: async (workspacePath, absolutePath) => {
    const { blameGen, blameCache, inflightBlame } = get();
    const cached = blameCache.get(absolutePath);
    if (cached && cached.gen === blameGen) return cached.lines;
    const inflight = inflightBlame.get(absolutePath);
    if (inflight) return inflight;

    const relPath = absolutePath.startsWith(workspacePath + '/')
      ? absolutePath.slice(workspacePath.length + 1)
      : absolutePath;

    const promise = (async () => {
      try {
        const lines = await invoke<BlameLine[]>('git_blame_file', {
          workspacePath,
          filePath: relPath,
        });
        const nextCache = new Map(get().blameCache);
        nextCache.set(absolutePath, { gen: get().blameGen, lines });
        const nextInflight = new Map(get().inflightBlame);
        nextInflight.delete(absolutePath);
        set({ blameCache: nextCache, inflightBlame: nextInflight });
        return lines;
      } catch (err) {
        console.error('[git] getBlame failed:', err);
        const nextInflight = new Map(get().inflightBlame);
        nextInflight.delete(absolutePath);
        set({ inflightBlame: nextInflight });
        return [];
      }
    })();

    const nextInflight = new Map(inflightBlame);
    nextInflight.set(absolutePath, promise);
    set({ inflightBlame: nextInflight });
    return promise;
  },

  invalidateBlameAll: () => {
    set({
      blameGen: get().blameGen + 1,
      blameCache: new Map(),
      inflightBlame: new Map(),
    });
  },

  invalidateBlameFile: (absolutePath) => {
    const cache = new Map(get().blameCache);
    cache.delete(absolutePath);
    const inflight = new Map(get().inflightBlame);
    inflight.delete(absolutePath);
    set({ blameCache: cache, inflightBlame: inflight });
  },

  getCommitDetail: async (workspacePath, hash) => {
    const { commitDetails, inflightCommitDetails } = get();
    const cached = commitDetails.get(hash);
    if (cached) return cached;
    const inflight = inflightCommitDetails.get(hash);
    if (inflight) return inflight;

    const promise = (async () => {
      try {
        const detail = await invoke<CommitDetail>('git_show_commit', { workspacePath, hash });
        const nextDetails = new Map(get().commitDetails);
        nextDetails.set(hash, detail);
        const nextInflight = new Map(get().inflightCommitDetails);
        nextInflight.delete(hash);
        set({ commitDetails: nextDetails, inflightCommitDetails: nextInflight });
        return detail;
      } catch (err) {
        const nextInflight = new Map(get().inflightCommitDetails);
        nextInflight.delete(hash);
        set({ inflightCommitDetails: nextInflight });
        notify.error(`Failed to load commit ${hash.slice(0, 7)}: ${err}`);
        return null;
      }
    })();

    const nextInflight = new Map(inflightCommitDetails);
    nextInflight.set(hash, promise);
    set({ inflightCommitDetails: nextInflight });
    return promise;
  },
}));
