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
import {
  parseInputActions,
  listActions,
  findBindingConflicts,
  type BindingConflict,
} from '../../../utils/inputactions-model';
import { detectInputSystem, type InputSystemMode } from '../../../utils/input-system';

export interface KnownAction {
  qualifiedName: string;
  name: string;
  mapName: string;
  /** `Button`, `Vector2`, `Axis`, ... — what `ReadValue<T>()` must agree with. */
  expectedControlType: string | null;
  /** True when another action in the same map claims one of its controls. */
  starved: boolean;
}

export interface InputActionsIndex {
  /** Unqualified action name -> its definitions (a name can repeat across maps). */
  byName: Map<string, KnownAction[]>;
  /** `Map/Action` -> definition. */
  byQualifiedName: Map<string, KnownAction>;
  /** Every map name in the project. */
  mapNames: Set<string>;
  conflicts: BindingConflict[];
  assetCount: number;
  /** Which input system the project runs, so rules can gate on it. */
  inputSystem: InputSystemMode;
}

export interface RawAsset {
  path: string;
  content: string;
}

/**
 * Build the index from already-read assets. Pure, so the rules can be tested
 * without a Tauri mock.
 */
export function buildInputActionsIndex(
  assets: readonly RawAsset[],
  inputSystem: InputSystemMode,
): InputActionsIndex {
  const byName = new Map<string, KnownAction[]>();
  const byQualifiedName = new Map<string, KnownAction>();
  const mapNames = new Set<string>();
  const conflicts: BindingConflict[] = [];
  let assetCount = 0;

  for (const asset of assets) {
    const parsed = parseInputActions(asset.content);
    if (!parsed.doc) continue;
    assetCount++;

    const assetConflicts = findBindingConflicts(parsed.doc);
    conflicts.push(...assetConflicts);
    const starvedNames = new Set(assetConflicts.flatMap((c) => c.starved));

    for (const map of parsed.doc.maps) mapNames.add(map.name);

    for (const action of listActions(parsed.doc)) {
      const known: KnownAction = {
        qualifiedName: action.qualifiedName,
        name: action.name,
        mapName: action.mapName,
        expectedControlType: action.expectedControlType ?? null,
        starved: starvedNames.has(action.qualifiedName),
      };
      byQualifiedName.set(known.qualifiedName, known);
      const list = byName.get(known.name);
      if (list) list.push(known);
      else byName.set(known.name, [known]);
    }
  }

  return { byName, byQualifiedName, mapNames, conflicts, assetCount, inputSystem };
}

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

      const settings = await invoke<string>('read_file', {
        path: `${workspacePath}/ProjectSettings/ProjectSettings.asset`,
      }).catch(() => null);

      cached = buildInputActionsIndex(assets, detectInputSystem(settings, assetPaths.length > 0));
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
