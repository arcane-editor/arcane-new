/**
 * The parsed, project-wide view of every `.inputactions` asset.
 *
 * In `utils/` for the same reason `inputactions-model.ts` and
 * `input-system.ts` are: the analyzer feature's barrel pulls Monaco and the
 * theme store, so anything importing it from outside dies under Bun's DOM-less
 * test runtime on `document is not defined`. This half is pure, and both the
 * analyzer rules and the AI harness's `unity_input_actions` tool need it.
 *
 * The async cache that primes it stays in
 * `features/unity-analyzers/services/inputactions-cache.ts`, which re-exports
 * everything here so existing callers are unaffected.
 */

import {
  parseInputActions,
  listActions,
  findBindingConflicts,
  type BindingConflict,
} from './inputactions-model';
import type { InputSystemMode } from './input-system';

export interface KnownAction {
  qualifiedName: string;
  name: string;
  mapName: string;
  /** `Button`, `Vector2`, `Axis`, ... — what `ReadValue<T>()` must agree with. */
  expectedControlType: string | null;
  /** True when another action in the same map claims one of its controls. */
  starved: boolean;
  /** `Value` / `Button` / `PassThrough` — the action's own type. */
  actionType: string | null;
  /**
   * Control paths bound to this action, composites rendered as their label.
   *
   * The rules need none of this — a linter only has to know an action exists
   * and what it reads as. It is here for the AI tool, which has to WRITE input
   * code: "does Jump already have a gamepad binding?" is unanswerable from a
   * name and a control type alone.
   */
  bindings: string[];
  /** Control schemes the bindings belong to; empty means every scheme. */
  schemes: string[];
  /** The `.inputactions` asset this action is declared in. */
  assetPath: string;
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
  /** Paths of the parsed assets, in scan order. */
  assetPaths: string[];
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
  const assetPaths: string[] = [];
  let assetCount = 0;

  for (const asset of assets) {
    const parsed = parseInputActions(asset.content);
    if (!parsed.doc) continue;
    assetCount++;
    assetPaths.push(asset.path);

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
        actionType: action.type ?? null,
        bindings: action.bindings.map((b) => b.label),
        schemes: [...new Set(action.bindings.flatMap((b) => b.schemes))],
        assetPath: asset.path,
      };
      byQualifiedName.set(known.qualifiedName, known);
      const list = byName.get(known.name);
      if (list) list.push(known);
      else byName.set(known.name, [known]);
    }
  }

  return { byName, byQualifiedName, mapNames, conflicts, assetCount, assetPaths, inputSystem };
}
