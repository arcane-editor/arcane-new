import { invoke } from '@tauri-apps/api/core';

// GUID <-> Asset path bidirectional map
let guidToPath = new Map<string, string>();
let pathToGuid = new Map<string, string>();
let scanned = false;

/**
 * Populate the GUID maps from the persistent Unity index (`unity_index_guid_map`).
 * The index's guid→path map is a superset of the legacy `scan_meta_files`
 * result (it walks Assets/ and Packages/ and persists across sessions), so this
 * is a drop-in replacement. The public API is unchanged; callers are untouched.
 */
export async function scanMetaFiles(workspacePath: string): Promise<void> {
  try {
    const results = await invoke<Record<string, string>>('unity_index_guid_map', {
      workspacePath,
    });

    guidToPath.clear();
    pathToGuid.clear();

    for (const [guid, path] of Object.entries(results)) {
      guidToPath.set(guid, path);
      pathToGuid.set(path, guid);
    }

    scanned = true;
  } catch (err) {
    console.warn('[GuidResolver] Failed to scan meta files:', err);
  }
}

export function resolveGuid(guid: string): string | undefined {
  return guidToPath.get(guid);
}

export function resolveAssetPath(assetPath: string): string | undefined {
  return pathToGuid.get(assetPath);
}

export function isScanned(): boolean {
  return scanned;
}

export function clearCache(): void {
  guidToPath.clear();
  pathToGuid.clear();
  scanned = false;
}
