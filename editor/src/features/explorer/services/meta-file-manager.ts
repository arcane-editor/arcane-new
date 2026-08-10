import { invoke } from '@tauri-apps/api/core';
import { notify } from '../../../stores/notifications';

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

/**
 * Rename the companion `.meta` alongside a renamed asset.
 *
 * A missing sidecar is fine and silent — plenty of files have none. Any OTHER
 * failure is not: the asset has already been renamed, so a meta left behind
 * orphans the asset's GUID and every scene and prefab reference to it. That
 * was previously swallowed by the same catch as "no meta here", on the
 * assumption that absence is the only way this can fail.
 */
export async function coRenameMeta(oldPath: string, newPath: string): Promise<void> {
  if (isMetaFile(oldPath)) return;
  const from = getMetaPath(oldPath);

  let exists = false;
  try {
    exists = await invoke<boolean>('path_exists', { path: from });
  } catch {
    // Cannot tell — attempt the rename and let its own error decide.
    exists = true;
  }
  if (!exists) return;

  try {
    await invoke('rename_path', { oldPath: from, newPath: getMetaPath(newPath) });
  } catch (err) {
    notify.error(
      `Renamed the asset but not its .meta — Unity will treat it as a new file and ` +
        `references to it may break. ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
