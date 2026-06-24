import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { GitLogEntry, WorktreeInfo, BlameLine } from '../types';
import { notify } from './notifications';
import { useWorkspaceStore } from './workspace';

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

interface GitState {
  branch: string | null;
  branches: string[];
  stagedFiles: GitFileStatus[];
  unstagedFiles: GitFileStatus[];
  commitMessage: string;
  isLoading: boolean;
  isGitRepo: boolean;
  ahead: number;
  behind: number;
  commitLog: GitLogEntry[];
  isRemoteLoading: boolean;
  lastError: string | null;

  worktrees: WorktreeInfo[];
  isLoadingWorktrees: boolean;
  blameGen: number;
  blameCache: Map<string, BlameEntry>;
  inflightBlame: Map<string, Promise<BlameLine[]>>;

  refreshStatus: (workspacePath: string) => Promise<void>;
  refreshBranches: (workspacePath: string) => Promise<void>;
  refreshLog: (workspacePath: string) => Promise<void>;
  switchBranch: (workspacePath: string, branch: string) => Promise<void>;
  stageFile: (workspacePath: string, filePath: string) => Promise<void>;
  unstageFile: (workspacePath: string, filePath: string) => Promise<void>;
  stageAll: (workspacePath: string) => Promise<void>;
  unstageAll: (workspacePath: string) => Promise<void>;
  discardFile: (workspacePath: string, filePath: string, isUntracked: boolean) => Promise<void>;
  discardAll: (workspacePath: string) => Promise<void>;
  commit: (workspacePath: string) => Promise<void>;
  setCommitMessage: (message: string) => void;

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

  getBlame: (workspacePath: string, absolutePath: string) => Promise<BlameLine[]>;
  invalidateBlameAll: () => void;
  invalidateBlameFile: (absolutePath: string) => void;
}

export const useGitStore = create<GitState>((set, get) => ({
  branch: null,
  branches: [],
  stagedFiles: [],
  unstagedFiles: [],
  commitMessage: '',
  isLoading: false,
  isGitRepo: false,
  ahead: 0,
  behind: 0,
  commitLog: [],
  isRemoteLoading: false,
  lastError: null,

  worktrees: [],
  isLoadingWorktrees: false,
  blameGen: 0,
  blameCache: new Map(),
  inflightBlame: new Map(),

  refreshStatus: async (workspacePath: string) => {
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
      });
      // Also refresh log in background
      get().refreshLog(workspacePath);
    } catch {
      set({
        branch: null,
        branches: [],
        stagedFiles: [],
        unstagedFiles: [],
        ahead: 0,
        behind: 0,
        isGitRepo: false,
        isLoading: false,
      });
    }
  },

  refreshBranches: async (workspacePath: string) => {
    try {
      const branches = await invoke<string[]>('git_list_branches', { workspacePath });
      set({ branches });
    } catch {
      set({ branches: [] });
    }
  },

  refreshLog: async (workspacePath: string) => {
    try {
      const entries = await invoke<GitLogEntry[]>('git_log', { workspacePath });
      set({ commitLog: entries });
    } catch {
      set({ commitLog: [] });
    }
  },

  switchBranch: async (workspacePath: string, branch: string) => {
    try {
      await invoke('git_switch_branch', { workspacePath, branch });
      get().invalidateBlameAll();
      await get().refreshStatus(workspacePath);

      // Reload open files from disk — branch switch likely changed their
      // content. Skip dirty files (would clobber unsaved work) and virtual
      // tabs. Refresh the tree so adds/deletes appear too.
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
          `Switched to ${branch}. ${skippedDirty.length} file${skippedDirty.length === 1 ? '' : 's'} with unsaved changes were not reloaded.`,
        );
      }
    } catch (err) {
      notify.error(`Failed to switch branch: ${err}`);
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
    const { commitMessage } = get();
    if (!commitMessage.trim()) return;
    try {
      await invoke('git_commit', { workspacePath, message: commitMessage });
      set({ commitMessage: '' });
      get().invalidateBlameAll();
      notify.success('Committed to ' + get().branch);
      await get().refreshStatus(workspacePath);
    } catch (err) {
      notify.error(`Commit failed: ${err}`);
      throw err;
    }
  },

  setCommitMessage: (message: string) => set({ commitMessage: message }),

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
      set({ lastError: `Fetch failed: ${err}` });
      notify.error('Fetch failed: ' + err);
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
      set({ lastError: `Pull failed: ${err}` });
      notify.error('Pull failed: ' + err);
    } finally {
      set({ isRemoteLoading: false });
    }
  },

  push: async (workspacePath: string) => {
    set({ isRemoteLoading: true, lastError: null });
    try {
      await invoke<string>('git_push', { workspacePath });
      await get().refreshStatus(workspacePath);
      notify.success('Changes pushed successfully');
    } catch (err) {
      set({ lastError: `Push failed: ${err}` });
      notify.error('Push failed: ' + err);
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
    stagedFiles: [],
    unstagedFiles: [],
    commitMessage: '',
    isLoading: false,
    isGitRepo: false,
    ahead: 0,
    behind: 0,
    commitLog: [],
    isRemoteLoading: false,
    lastError: null,
    worktrees: [],
    isLoadingWorktrees: false,
    blameGen: 0,
    blameCache: new Map(),
    inflightBlame: new Map(),
  }),

  refreshWorktrees: async (workspacePath: string) => {
    set({ isLoadingWorktrees: true });
    try {
      const worktrees = await invoke<WorktreeInfo[]>('git_worktree_list', { workspacePath });
      set({ worktrees, isLoadingWorktrees: false });
    } catch {
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
      } catch {
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
}));
