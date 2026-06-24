import { invoke } from '@tauri-apps/api/core';

const BRIDGE_PACKAGE_DIR = 'Packages/com.arcane.editor';

/**
 * Whether the Arcane bridge package is already embedded in the project
 * (`Packages/com.arcane.editor/package.json` exists).
 */
export async function isBridgeInstalled(workspacePath: string): Promise<boolean> {
  try {
    await invoke<string>('read_file', {
      path: `${workspacePath}/${BRIDGE_PACKAGE_DIR}/package.json`,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy the bundled Unity bridge package into the project's Packages/ folder.
 * Unity auto-discovers embedded packages, so no manifest.json edit is needed —
 * the user just refocuses Unity to trigger an import. Returns the install path.
 */
export async function installBridge(workspacePath: string): Promise<string> {
  return invoke<string>('unity_install_bridge', { workspacePath });
}

export const BRIDGE_DOCS_URL = 'https://docs.unity3d.com/Manual/upm-embed.html';
