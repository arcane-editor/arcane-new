/**
 * Cached `ProjectSettings/` snapshot for the analyzer rules.
 *
 * Analyzer rules run synchronously against a scanned document, but the settings
 * they validate against live on disk. So the snapshot is fetched once per
 * workspace and read synchronously afterwards; a rule that finds no snapshot
 * yields nothing rather than guessing, which keeps a cold start quiet instead
 * of flooding the Problems panel with false "tag is not defined" errors.
 */

import { invoke } from '@tauri-apps/api/core';

export interface BuildScene {
  path: string;
  enabled: boolean;
  guid: string;
}

export interface ProjectSettingsSnapshot {
  scriptingDefines: Record<string, string[]>;
  tags: string[];
  /** Index is the layer id; blank entries are unused slots. */
  layers: string[];
  scenes: BuildScene[];
  inputAxes: string[];
  serializationIsText: boolean;
}

let cached: ProjectSettingsSnapshot | null = null;
let cachedWorkspace: string | null = null;
let inFlight: Promise<void> | null = null;

/** The loaded snapshot, or null if none has been loaded for this workspace. */
export function getProjectSettings(): ProjectSettingsSnapshot | null {
  return cached;
}

/**
 * Load (or reload) the snapshot for a workspace. Safe to call repeatedly —
 * concurrent calls share one request, and a repeat call for the same workspace
 * refreshes rather than no-ops, because the user can edit tags and layers in
 * Unity while the editor is open.
 */
export async function loadProjectSettings(workspacePath: string | null): Promise<void> {
  if (!workspacePath) {
    cached = null;
    cachedWorkspace = null;
    return;
  }
  if (inFlight && cachedWorkspace === workspacePath) return inFlight;

  cachedWorkspace = workspacePath;
  inFlight = (async () => {
    try {
      cached = await invoke<ProjectSettingsSnapshot>('unity_project_settings', {
        workspacePath,
      });
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
export function __setProjectSettingsForTest(
  snap: ProjectSettingsSnapshot | null,
): void {
  cached = snap;
  cachedWorkspace = snap ? 'test' : null;
}
