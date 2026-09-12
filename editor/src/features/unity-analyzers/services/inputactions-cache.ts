/**
 * Cached `.inputactions` snapshot for the analyzer rules.
 *
 * Analyzer rules run **synchronously** against one scanned C# document, but
 * the truth they validate against lives in JSON assets elsewhere in the
 * project. Same shape as `unity-analyzers/services/project-settings-cache.ts`,
 * and for the same reason: fetch once per workspace, read synchronously
 * afterwards, and — critically — **a rule that finds no snapshot yields
 * nothing rather than guessing**. A cold start must stay quiet instead of
 * flooding the Problems panel with "action is not defined" on every literal in
 * the project.
 */

import { invoke } from '@tauri-apps/api/core';
import { readInputSystem } from '../../../utils/input-system';
import {
  buildInputActionsIndex,
  type InputActionsIndex,
  type RawAsset,
} from '../../../utils/inputactions-index';

// The pure half lives in `utils/` so the AI tool and its Bun tests can reach it
// without importing this feature's barrel (which pulls Monaco). Re-exported so
// the rules and the analyzers barrel keep their existing import.
export {
  buildInputActionsIndex,
  type InputActionsIndex,
  type KnownAction,
  type RawAsset,
} from '../../../utils/inputactions-index';

let cached: InputActionsIndex | null = null;
let cachedWorkspace: string | null = null;
let inFlight: Promise<void> | null = null;

/** The loaded index, or null if none has been loaded for this workspace. */
export function getInputActionsIndex(): InputActionsIndex | null {
  return cached;
}

const SCAN_EXCLUDES = ['Library/**', 'Temp/**', 'obj/**', 'Logs/**', 'Build/**', 'Builds/**'];

/**
 * Load (or reload) the snapshot for a workspace. Safe to call repeatedly —
 * concurrent calls share one request, and a repeat call for the same workspace
 * refreshes rather than no-ops, because the user can edit actions in Unity
 * while the editor is open.
 */
export async function loadInputActions(workspacePath: string | null): Promise<void> {
  if (!workspacePath) {
    cached = null;
    cachedWorkspace = null;
    return;
  }
  if (inFlight && cachedWorkspace === workspacePath) return inFlight;

  cachedWorkspace = workspacePath;
  inFlight = (async () => {
    try {
      const paths = await invoke<string[]>('scan_all_files_v2', {
        workspacePath,
        extraExcludes: SCAN_EXCLUDES,
      });
      const assetPaths = paths.filter((p) => p.toLowerCase().endsWith('.inputactions'));
      const assets =
        assetPaths.length === 0
          ? []
          : await invoke<RawAsset[]>('read_files_bulk', { paths: assetPaths });

      // `readInputSystem`, not a local `detectInputSystem` call: this used to
      // pass `assetPaths.length > 0` as the package signal while
      // `stores/project-context.ts` passed the `com.unity.inputsystem` manifest
      // dependency, so the analyzer and the Input Hub could disagree about the
      // same project. One reader, one answer.
      cached = buildInputActionsIndex(assets, await readInputSystem(workspacePath));
    } catch {
      // A failed read must not wedge the analyzer: leave the previous snapshot
      // (or null) in place and let the rules stay quiet.
      if (cachedWorkspace !== workspacePath) return;
      cached = null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Test seam — set the snapshot without touching Tauri. */
export function __setInputActionsIndexForTest(index: InputActionsIndex | null): void {
  cached = index;
  cachedWorkspace = index ? 'test' : null;
}
