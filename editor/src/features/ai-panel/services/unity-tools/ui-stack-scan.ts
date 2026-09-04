/**
 * The two project-wide signals `ui-stack.ts`'s detector needs that no other
 * scan already gathers: how many `PanelSettings` assets exist (a commitment
 * to UI Toolkit even before any `.uxml` does), and how many scenes/prefabs
 * place a Canvas (uGUI's).
 *
 * Split out of `unity-facts.ts` into its own file so it is directly testable
 * under Bun — `unity-facts.ts` itself is not (it statically imports
 * `stores/workspace.ts`, Bun-unsafe) — the same pure/IO split
 * `panel-resolve.ts` uses for the same reason, just with the IO half made
 * injectable instead of untestable.
 *
 * The `.unity`/`.prefab` AND `.asset` size guards both bound WORK, not just
 * the answer: sizes are fetched first (a cheap stat, `file_sizes_bulk` — no
 * file content read), and only paths at or under the cap are ever handed to
 * `read_files_bulk`. A multi-hundred-MB baked scene (or a huge serialized
 * ScriptableObject `.asset`) is skipped before a single byte of it is read,
 * not filtered out afterward. Same cap, same technique, for the same reason
 * `unity-facts.ts`'s `readPanelSettingsFacts` (Task 16) applies to its own
 * `.asset` scan — fix round 1, M2: this scan and that one must not disagree
 * about which `.asset` files are even eligible to be read.
 */

import { invoke } from '@tauri-apps/api/core';

const SCAN_EXCLUDES = ['Library/**', 'Temp/**', 'obj/**', 'Logs/**', 'Build/**', 'Builds/**'];
const READ_CHUNK = 200;
/** `canvasScenes`' own size guard — see `ui-stack.ts`'s `UiStackSignals.canvasScenes`. */
const MAX_SCENE_BYTES = 2 * 1024 * 1024;
/** `panelSettingsCount`'s own size guard — same cap as `unity-facts.ts`'s `MAX_PANEL_ASSET_BYTES`. */
const MAX_ASSET_BYTES = 2 * 1024 * 1024;

export interface UiStackScanResult {
  panelSettingsCount: number;
  canvasScenes: number;
}

export interface UiStackScanDeps {
  scan: (workspacePath: string, extraExcludes: readonly string[]) => Promise<string[]>;
  /** Cheap stat — path + byte size, no content. */
  sizesOf: (paths: string[]) => Promise<Array<{ path: string; size: number }>>;
  readFiles: (paths: string[]) => Promise<Array<{ path: string; content: string }>>;
}

export const defaultUiStackScanDeps: UiStackScanDeps = {
  scan: (workspacePath, extraExcludes) =>
    invoke<string[]>('scan_all_files_v2', { workspacePath, extraExcludes: [...extraExcludes] }),
  sizesOf: (paths) => invoke('file_sizes_bulk', { paths }),
  readFiles: (paths) => invoke('read_files_bulk', { paths }),
};

/** Chunked `fn` over `list`, same shape `panel-resolve.ts` uses. A chunk that fails narrows the answer; it does not break it. */
async function inChunks<T>(
  list: readonly string[],
  chunkSize: number,
  fn: (chunk: string[]) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < list.length; i += chunkSize) {
    try {
      out.push(...(await fn(list.slice(i, i + chunkSize))));
    } catch {
      // See header — one bad chunk must not take the whole scan down.
    }
  }
  return out;
}

/**
 * Failure (the scan itself, every size chunk, every read chunk) degrades to
 * "neither stack detected" (0/0), never a thrown prime — this feeds
 * `unity-facts.ts`'s `primeUnityFacts`, which must never fail a whole prime
 * over one signal.
 */
export async function readUiStackSignals(
  workspacePath: string,
  deps: UiStackScanDeps = defaultUiStackScanDeps,
): Promise<UiStackScanResult> {
  let paths: string[];
  try {
    paths = await deps.scan(workspacePath, SCAN_EXCLUDES);
  } catch {
    return { panelSettingsCount: 0, canvasScenes: 0 };
  }

  // Size-first, same shape as the scene/prefab scan below: stat every `.asset`
  // candidate, then read only the ones at or under the cap.
  const assetCandidates = paths.filter((p) => p.endsWith('.asset'));
  const assetSizes = await inChunks(assetCandidates, READ_CHUNK, deps.sizesOf);
  const assetsUnderCap = assetSizes.filter((s) => s.size <= MAX_ASSET_BYTES).map((s) => s.path);
  const assets = await inChunks(assetsUnderCap, READ_CHUNK, deps.readFiles);
  const panelSettingsCount = assets.filter((a) =>
    a.content.includes('UnityEngine.UIElements.PanelSettings'),
  ).length;

  // Size-first: stat every scene/prefab candidate, then read only the ones at
  // or under the cap. Reading everything and filtering by `content.length`
  // afterward (the bug this module was split out to fix) pays for reading a
  // huge scene in full just to then discard it.
  const sceneCandidates = paths.filter((p) => p.endsWith('.unity') || p.endsWith('.prefab'));
  const sizes = await inChunks(sceneCandidates, READ_CHUNK, deps.sizesOf);
  const underCap = sizes.filter((s) => s.size <= MAX_SCENE_BYTES).map((s) => s.path);
  const scenes = await inChunks(underCap, READ_CHUNK, deps.readFiles);
  const canvasScenes = scenes.filter((s) => s.content.includes('--- !u!223')).length;

  return { panelSettingsCount, canvasScenes };
}
