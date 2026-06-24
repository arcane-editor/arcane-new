import { invoke } from '@tauri-apps/api/core';

/** Read a .cs (or any asset) file's GUID from its paired `.meta` file. */
export async function readScriptGuidFromMeta(absPath: string): Promise<string | null> {
  try {
    const meta = await invoke<string>('read_file', { path: `${absPath}.meta` });
    const m = /guid:\s*([0-9a-fA-F]{32})/.exec(meta);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
