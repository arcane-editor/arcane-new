import { invoke } from '@tauri-apps/api/core';

function isMetaFile(path: string): boolean {
  return path.endsWith('.meta');
}

function getMetaPath(path: string): string {
  return path + '.meta';
}

/** Delete the companion .meta file for a given path (silently fails if none exists). */
export async function coDeleteMeta(path: string): Promise<void> {
  if (isMetaFile(path)) return;
  try {
    await invoke('delete_path', { path: getMetaPath(path) });
  } catch {
    // .meta file doesn't exist — that's fine
  }
}

/** Read an asset's GUID from its companion `.meta` file (null if missing). */
export async function readMetaGuid(path: string): Promise<string | null> {
  if (isMetaFile(path)) return null;
  try {
    const content = await invoke<string>('read_file', { path: getMetaPath(path) });
    const m = /guid:\s*([0-9a-fA-F]{32})/.exec(content);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Rename the companion .meta file alongside a renamed asset (silently fails if none exists). */
export async function coRenameMeta(oldPath: string, newPath: string): Promise<void> {
  if (isMetaFile(oldPath)) return;
  try {
    await invoke('rename_path', { oldPath: getMetaPath(oldPath), newPath: getMetaPath(newPath) });
  } catch {
    // .meta file doesn't exist — that's fine
  }
}
