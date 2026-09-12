import { invoke } from '@tauri-apps/api/core';

/**
 * The UPM id of the package THIS build bundles.
 *
 * There are two — the release app ships `com.unityide.editor`, the dev app
 * ships `com.unityide.editor.dev` — so it cannot be a constant here. Asked of
 * Rust, which reads it out of the bundled package itself.
 *
 * Cached after the first answer: it is fixed for the life of the process, and
 * this is called on every workspace open.
 */
let packageIdPromise: Promise<string> | null = null;

function bridgePackageId(): Promise<string> {
  if (!packageIdPromise) {
    packageIdPromise = invoke<string>('unity_bridge_package_id').catch((e) => {
      // Do not cache a failure — the resource may simply not be readable yet.
      packageIdPromise = null;
      throw e;
    });
  }
  return packageIdPromise;
}

/**
 * Whether this build's bridge package is already embedded in the project
 * (`Packages/<id>/package.json` exists).
 *
 * Deliberately asks about OUR package only. A project carrying the other
 * channel's package is NOT installed as far as this build is concerned — it
 * points at a different application — and reporting it as installed would
 * leave the user with a bridge that never connects and no prompt to fix it.
 */
export async function isBridgeInstalled(workspacePath: string): Promise<boolean> {
  try {
    const id = await bridgePackageId();
    await invoke<string>('read_file', {
      path: `${workspacePath}/Packages/${id}/package.json`,
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
 *
 * Also removes the other channel's package, and the pre-rename one, if either
 * is there: two embedded packages both registering an `IExternalCodeEditor`
 * would leave Unity picking which application your double-clicks open.
 */
export async function installBridge(workspacePath: string): Promise<string> {
  return invoke<string>('unity_install_bridge', { workspacePath });
}

export const BRIDGE_DOCS_URL = 'https://docs.unity3d.com/Manual/upm-embed.html';
