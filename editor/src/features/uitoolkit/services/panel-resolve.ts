// Which `PanelSettings` this UXML is rendered through.
//
// The preview cannot lay a document out until it knows the panel's size, and
// the panel is not named anywhere in the UXML — the link lives in whatever
// scene or prefab carries the `UIDocument`. So this is a guid join, and like
// every other join in this codebase it runs behind a ladder rather than a
// guess: an exact answer where one exists, a stated assumption where it does
// not, and the screen default where neither holds.
//
// No store imports: `stores/unity-index` reaches `stores/theme`, which touches
// `document` at module scope and takes the Bun suite down on import alone.

import { invoke } from '@tauri-apps/api/core';
import {
  parsePanelSettings,
  findPanelSettingsRef,
  guidFromMeta,
  type PanelSettings,
} from '../../../utils/panel-settings';

export type PanelConfidence =
  /** A UIDocument in a scene or prefab renders this UXML through it. */
  | 'wired'
  /** The project has exactly one, so it is the one. */
  | 'only'
  /** Several exist and none is wired to this document. */
  | 'ambiguous'
  /** None found. */
  | 'none';

export interface PanelResolution {
  settings: PanelSettings | null;
  confidence: PanelConfidence;
  /** Workspace-relative path of the asset, for the header link. */
  path: string | null;
  /** How many PanelSettings assets the project has. */
  candidates: number;
}

export const NO_PANEL: PanelResolution = {
  settings: null,
  confidence: 'none',
  path: null,
  candidates: 0,
};

const SCAN_EXCLUDES = ['Library/**', 'Temp/**', 'obj/**', 'Logs/**', 'Build/**', 'Builds/**'];
const CHUNK = 200;

interface RawFile {
  path: string;
  content: string;
}

/**
 * Pure half: pick a panel out of already-read files.
 *
 * `scenes` are every scene and prefab; `assets` every `.asset`. Split out so
 * the ladder is testable without a Unity project on disk.
 */
export function choosePanel(
  uxmlGuid: string | null,
  scenes: readonly RawFile[],
  assets: readonly RawFile[],
  guidOf: (path: string) => string | null,
): PanelResolution {
  const panels: Array<{ path: string; settings: PanelSettings }> = [];
  for (const asset of assets) {
    const settings = parsePanelSettings(asset.content, asset.path);
    if (settings) panels.push({ path: asset.path, settings });
  }
  if (panels.length === 0) return NO_PANEL;

  if (uxmlGuid) {
    for (const scene of scenes) {
      const guid = findPanelSettingsRef(scene.content, uxmlGuid);
      if (!guid) continue;
      const hit = panels.find((p) => guidOf(p.path) === guid);
      if (hit) {
        return { settings: hit.settings, confidence: 'wired', path: hit.path, candidates: panels.length };
      }
    }
  }

  return {
    settings: panels[0].settings,
    // One candidate is an answer; several without a wiring is an assumption,
    // and the header says which of the two the reader is looking at.
    confidence: panels.length === 1 ? 'only' : 'ambiguous',
    path: panels[0].path,
    candidates: panels.length,
  };
}

/**
 * Find the panel for `uxmlPath`.
 *
 * Returns `NO_PANEL` on any failure rather than throwing: falling back to the
 * screen size renders something honest, a crashed preview renders nothing.
 */
export async function loadPanelSettings(
  uxmlPath: string,
  workspacePath: string | null,
): Promise<PanelResolution> {
  if (!workspacePath) return NO_PANEL;

  let paths: string[];
  try {
    paths = await invoke<string[]>('scan_all_files_v2', {
      workspacePath,
      extraExcludes: SCAN_EXCLUDES,
    });
  } catch {
    return NO_PANEL;
  }

  const read = async (list: string[]): Promise<RawFile[]> => {
    const out: RawFile[] = [];
    for (let i = 0; i < list.length; i += CHUNK) {
      try {
        out.push(...(await invoke<RawFile[]>('read_files_bulk', { paths: list.slice(i, i + CHUNK) })));
      } catch {
        // A chunk that cannot be read narrows the answer; it does not break it.
      }
    }
    return out;
  };

  const absolute = (p: string) => (p.startsWith('/') ? p : `${workspacePath}/${p}`);
  const assetPaths = paths.filter((p) => p.endsWith('.asset'));

  // Assets first, and nothing else until they say something. A project with no
  // PanelSettings has no question to answer, and one with a single PanelSettings
  // has the same answer whether or not a UIDocument names it — so neither case
  // is worth reading every scene and prefab in the project for.
  const assets = await read(assetPaths);
  const panelPaths = assets
    .filter((a) => a.content.includes('UnityEngine.UIElements.PanelSettings'))
    .map((a) => a.path);
  if (panelPaths.length === 0) return NO_PANEL;

  const uxmlMeta = await read([absolute(`${uxmlPath}.meta`)]);
  const uxmlGuid = uxmlMeta.length > 0 ? guidFromMeta(uxmlMeta[0].content) : null;

  const disambiguate = panelPaths.length > 1 && uxmlGuid !== null;
  const [scenes, metas] = await Promise.all([
    disambiguate
      ? read(paths.filter((p) => p.endsWith('.unity') || p.endsWith('.prefab')))
      : Promise.resolve([]),
    // Only the candidates' own metas: one per PanelSettings, not one per asset.
    read(panelPaths.map((p) => `${p}.meta`)),
  ]);

  const metaByPath = new Map(metas.map((m) => [m.path.replace(/\.meta$/, ''), m.content]));
  const guidOf = (path: string): string | null => {
    const meta = metaByPath.get(path) ?? metaByPath.get(absolute(path));
    return meta ? guidFromMeta(meta) : null;
  };

  return choosePanel(uxmlGuid, scenes, assets, guidOf);
}
