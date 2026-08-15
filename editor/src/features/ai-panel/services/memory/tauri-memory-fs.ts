/**
 * Live `MemoryFs` over the existing Tauri fs commands. Kept in its own module
 * so everything else in memory/ stays free of Tauri imports (Bun-testable).
 */

import { invoke } from '@tauri-apps/api/core';
import type { MemoryFs } from './memory-types';

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export const tauriMemoryFs: MemoryFs = {
  read(path) {
    return invoke<string>('read_file', { path });
  },
  async write(path, content) {
    await invoke('write_file', { path, contents: content });
  },
  async list(dir) {
    try {
      const entries = await invoke<FileEntry[]>('read_directory', { path: dir });
      return entries.filter((e) => !e.is_dir).map((e) => e.name);
    } catch {
      return []; // missing directory = empty store
    }
  },
  async remove(path) {
    await invoke('delete_path', { path });
  },
  async mkdirp(dir) {
    await invoke('create_directory_recursive', { path: dir });
  },
};
