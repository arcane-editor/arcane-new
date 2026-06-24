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

// ---- Read Operations ----

export const tauriReadOperations: ReadOperations = {
  readFile: async (absolutePath: string): Promise<string> => {
    return invoke<string>('read_file', { path: absolutePath });
  },

  access: async (absolutePath: string): Promise<void> => {
    // Attempt to read; throws if file doesn't exist
    await invoke<string>('read_file', { path: absolutePath });
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
 */
export function onFileWritten(absolutePath: string): void {
  const store = useWorkspaceStore.getState();
  // Refresh file tree
  store.refreshTree();
  // If the file is open, re-read its content
  const openFile = store.openFiles.find((f) => f.path === absolutePath);
  if (openFile) {
    invoke<string>('read_file', { path: absolutePath }).then((content) => {
      store.updateFileContent(absolutePath, content);
    });
  }
}

/**
 * Called after a file is edited by the edit tool.
 * Same as onFileWritten — refresh tree and update editors.
 */
export function onFileEdited(absolutePath: string): void {
  onFileWritten(absolutePath);
}
