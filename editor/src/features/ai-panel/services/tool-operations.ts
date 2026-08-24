/**
 * Tauri-backed tool operations.
 * Implements PI's operations interfaces using Tauri invoke() commands.
 */

import { invoke } from '@tauri-apps/api/core';
import { useWorkspaceStore } from '../../../stores/workspace';
import type { ReadOperations } from './vendor/tools/read';
import type { WriteOperations } from './vendor/tools/write';
import type { EditOperations } from './vendor/tools/edit';
import type { BashOperations } from './vendor/tools/bash';
import type { ListOperations } from './vendor/tools/list';
import type { RealPathOps } from './vendor/tools/real-path-guard';

// ---- Read Operations ----

export const tauriReadOperations: ReadOperations = {
  readFile: async (absolutePath: string): Promise<string> => {
    return invoke<string>('read_file', { path: absolutePath });
  },

  access: async (absolutePath: string): Promise<void> => {
    // A real existence probe. This used to be a full `read_file`, which made
    // every successful read decode the file TWICE and — worse — made a binary
    // file fail the probe, so `read` answered "File not found" for a file that
    // exists (see the decode branch in vendor/tools/read.ts).
    const exists = await invoke<boolean>('path_exists', { path: absolutePath });
    if (!exists) throw new Error(`File not found: ${absolutePath}`);
  },
};

// ---- List Operations ----

interface TauriDirEntry {
  name: string;
  is_dir: boolean;
  // (other fields exist on the backend type; only name + is_dir are used here)
}

export const tauriListOperations: ListOperations = {
  scanAll: async (absolutePath: string): Promise<string[]> => {
    return invoke<string[]>('scan_all_files', { workspacePath: absolutePath });
  },

  readDirectory: async (
    absolutePath: string,
  ): Promise<{ name: string; isDir: boolean }[]> => {
    const entries = await invoke<TauriDirEntry[]>('read_directory', {
      path: absolutePath,
    });
    return entries.map((e) => ({ name: e.name, isDir: e.is_dir }));
  },
};

// ---- Write Operations ----

export const tauriWriteOperations: WriteOperations = {
  writeFile: async (absolutePath: string, content: string): Promise<void> => {
    await invoke('write_file', { path: absolutePath, contents: content });
  },

  mkdir: async (absolutePath: string): Promise<void> => {
    await invoke('create_directory_recursive', { path: absolutePath });
  },
};

// ---- Edit Operations ----

export const tauriEditOperations: EditOperations = {
  readFile: tauriReadOperations.readFile,
  writeFile: tauriWriteOperations.writeFile,
  access: tauriReadOperations.access,
};

// ---- Bash Operations ----

interface CommandOutput {
  stdout: string;
  stderr: string;
  exit_code: number;
}

export const tauriBashOperations: BashOperations = {
  exec: async (
    command: string,
    cwd: string,
    options?: { timeout?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    const result = await invoke<CommandOutput>('execute_command', {
      command,
      cwd,
      timeoutMs: options?.timeout,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exit_code,
    };
  },
};

// ---- Workspace sync callbacks ----

/**
 * Called after a file is written by the write tool.
 * Refreshes the file tree and updates open editors.
 *
 * T8 fix (false-dirty tabs after an agent write): this used to pair a raw
 * `read_file` with `updateFileContent`, which unconditionally marks the tab
 * `isDirty: true` — correct for a USER edit, wrong here since the write
 * already landed on disk and there's nothing unsaved about it. `reloadFileFromDisk`
 * (`stores/workspace.ts` — the same primitive `stores/checkpoints.ts`'s
 * `restoreFile`/`restoreTurn` use to sync a tab after a restore) already
 * guards unopened files, sets `isDirty: false`, and re-syncs the LSP.
 */
export function onFileWritten(absolutePath: string): void {
  const store = useWorkspaceStore.getState();
  // Refresh file tree
  store.refreshTree();
  // If the file is open, reload it straight from disk.
  void store.reloadFileFromDisk(absolutePath);
}

/**
 * Called after a file is edited by the edit tool.
 * Same as onFileWritten — refresh tree and update editors.
 */
export function onFileEdited(absolutePath: string): void {
  onFileWritten(absolutePath);
}

// ---- Real-path (symlink) Operations ----

/**
 * Backs `withRealPathGuard`. `path_exists` is `is_file()`-only by design, so a
 * directory ancestor needs `dir_exists` as well — the guard walks ancestors, and
 * those are directories.
 */
export const tauriRealPathOperations: RealPathOps = {
  canonicalize: async (absPath: string): Promise<string> => {
    return invoke<string>('canonicalize_path', { path: absPath });
  },
  exists: async (absPath: string): Promise<boolean> => {
    const [isFile, isDir] = await Promise.all([
      invoke<boolean>('path_exists', { path: absPath }),
      invoke<boolean>('dir_exists', { path: absPath }),
    ]);
    return isFile || isDir;
  },
};
