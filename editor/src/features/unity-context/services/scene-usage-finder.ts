import { invoke } from '@tauri-apps/api/core';
import { useUnityIndexStore } from '../../../stores/unity-index';
import {
  parseSceneFile,
  parseScriptableObjectAsset,
  extractMonoBehaviourFields,
  type SceneFieldRef,
} from './scene-parser';

export type { SceneFieldRef };

export type AssetKind = 'scene' | 'prefab' | 'scriptableObject';

export interface SceneGameObjectRef {
  name: string;
  fileId: string;
  fields: SceneFieldRef[];
}

export interface AssetUsageEntry {
  kind: AssetKind;
  assetName: string;
  assetPath: string;
  refCount: number;
  gameObjects: SceneGameObjectRef[];
  // ScriptableObject-only fields:
  assetGuid?: string;        // .meta GUID of this .asset, present when isInstance
  isInstance?: boolean;      // true => .asset is an instance of the open SO script
  fields?: SceneFieldRef[];  // top-level serialized fields of the SO instance
}

const META_GUID_REGEX = /^guid:\s*([a-f0-9]{32})\s*$/m;

export async function readScriptGuid(scriptAbsPath: string): Promise<string | null> {
  try {
    const content = await invoke<string>('read_file', { path: scriptAbsPath + '.meta' });
    const match = META_GUID_REGEX.exec(content);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function classifyAsset(path: string): AssetKind | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.unity')) return 'scene';
  if (lower.endsWith('.prefab')) return 'prefab';
  if (lower.endsWith('.asset')) return 'scriptableObject';
  return null;
}

function buildSceneOrPrefabEntry(
  kind: 'scene' | 'prefab',
  assetPath: string,
  content: string,
  scriptGuid: string,
): AssetUsageEntry {
  const assetName = assetPath.split('/').pop() ?? assetPath;

  let graph;
  try {
    graph = parseSceneFile(content);
  } catch {
    // Prefab YAML occasionally fails structural parse — fall back to a
    // minimal "found here" entry so the user still sees the reference.
    return { kind, assetName, assetPath, refCount: 1, gameObjects: [] };
  }

  const matches: SceneGameObjectRef[] = [];
  for (const go of graph.gameObjects) {
    const matchingComponents = go.components.filter(
      (c) => c.classId === '114' && c.scriptGuid === scriptGuid,
    );
    if (matchingComponents.length === 0) continue;
    const fields: SceneFieldRef[] = [];
    for (const comp of matchingComponents) {
      if (comp.rawContent) {
        fields.push(...extractMonoBehaviourFields(comp.rawContent));
      }
    }
    matches.push({ name: go.name, fileId: go.fileId, fields });
  }

  if (matches.length === 0) {
    return { kind, assetName, assetPath, refCount: 1, gameObjects: [] };
  }
  return { kind, assetName, assetPath, refCount: matches.length, gameObjects: matches };
}

async function buildScriptableObjectEntry(
  assetPath: string,
  content: string,
  openScriptGuid: string,
): Promise<AssetUsageEntry> {
  const assetName = assetPath.split('/').pop() ?? assetPath;
  const { scriptGuid, fields } = parseScriptableObjectAsset(content);

  if (scriptGuid && scriptGuid === openScriptGuid) {
    // This .asset is an instance of the open script.
    const assetGuid = (await readScriptGuid(assetPath)) ?? undefined;
    return {
      kind: 'scriptableObject',
      assetName,
      assetPath,
      refCount: 1,
      gameObjects: [],
      isInstance: true,
      assetGuid,
      fields,
    };
  }

  // .asset references the open script via a serialized field (rare).
  return {
    kind: 'scriptableObject',
    assetName,
    assetPath,
    refCount: 1,
    gameObjects: [],
    isInstance: false,
  };
}

/**
 * Find every scene / prefab / ScriptableObject that references a C# script,
 * keyed by the script's `.meta` GUID.
 *
 * Powered by the persistent Rust reverse-reference index
 * (`unity_index_find_references`): the index already knows which files mention
 * `scriptGuid`, so we only read+parse those specific hits to extract per-
 * GameObject detail — no full-project scan. This works with Unity closed
 * (the index is persisted) and is dramatically cheaper than scanning every
 * scene/prefab on demand.
 */
export async function findAssetUsages(
  workspacePath: string,
  scriptGuid: string,
): Promise<AssetUsageEntry[]> {
  void workspacePath; // workspace is resolved inside the index store
  const hits = await useUnityIndexStore.getState().findReferences(scriptGuid);
  const entries: AssetUsageEntry[] = [];

  for (let i = 0; i < hits.length; i++) {
    const assetPath = hits[i].path;
    const kind = classifyAsset(assetPath);
    // The index also tracks .mat/.controller/.anim references; the usage panel
    // only surfaces scenes, prefabs, and ScriptableObjects.
    if (!kind) continue;
    if (i % 4 === 0) await Promise.resolve();

    let content: string;
    try {
      content = await invoke<string>('read_file', { path: assetPath });
    } catch {
      // File vanished since the index was built — fall back to a count-only row
      // so the user still sees the reference.
      const assetName = assetPath.split('/').pop() ?? assetPath;
      entries.push({ kind, assetName, assetPath, refCount: hits[i].count, gameObjects: [] });
      continue;
    }

    if (kind === 'scriptableObject') {
      entries.push(await buildScriptableObjectEntry(assetPath, content, scriptGuid));
    } else {
      entries.push(buildSceneOrPrefabEntry(kind, assetPath, content, scriptGuid));
    }
  }

  entries.sort((a, b) => a.assetName.localeCompare(b.assetName));
  return entries;
}

/**
 * Level-2 scan: given a ScriptableObject *instance* asset's GUID, find every
 * scene / prefab / other .asset that references it. Used when the user
 * expands an instance row in the panel.
 */
export async function findInstanceUsages(
  workspacePath: string,
  instanceAssetGuid: string,
): Promise<AssetUsageEntry[]> {
  void workspacePath; // workspace is resolved inside the index store
  const hits = await useUnityIndexStore.getState().findReferences(instanceAssetGuid);
  const entries: AssetUsageEntry[] = [];

  for (let i = 0; i < hits.length; i++) {
    const assetPath = hits[i].path;
    const kind = classifyAsset(assetPath);
    if (!kind) continue;
    if (i % 4 === 0) await Promise.resolve();

    let content: string;
    try {
      content = await invoke<string>('read_file', { path: assetPath });
    } catch {
      const fallbackName = assetPath.split('/').pop() ?? assetPath;
      entries.push({ kind, assetName: fallbackName, assetPath, refCount: hits[i].count, gameObjects: [] });
      continue;
    }

    const assetName = assetPath.split('/').pop() ?? assetPath;

    if (kind === 'scriptableObject') {
      // Skip the instance referencing itself (its own .meta is separate, but
      // the .asset content shouldn't normally contain its own GUID).
      entries.push({
        kind: 'scriptableObject',
        assetName,
        assetPath,
        refCount: 1,
        gameObjects: [],
        isInstance: false,
      });
      continue;
    }

    // Scene or prefab — find every GameObject whose components reference
    // this instance GUID anywhere in their raw YAML content.
    let graph;
    try {
      graph = parseSceneFile(content);
    } catch {
      entries.push({ kind, assetName, assetPath, refCount: 1, gameObjects: [] });
      continue;
    }

    const matches: SceneGameObjectRef[] = [];
    for (const go of graph.gameObjects) {
      const hit = go.components.some(
        (c) => c.rawContent && c.rawContent.includes(instanceAssetGuid),
      );
      if (!hit) continue;
      matches.push({ name: go.name, fileId: go.fileId, fields: [] });
    }

    if (matches.length === 0) {
      entries.push({ kind, assetName, assetPath, refCount: 1, gameObjects: [] });
    } else {
      entries.push({ kind, assetName, assetPath, refCount: matches.length, gameObjects: matches });
    }
  }

  entries.sort((a, b) => a.assetName.localeCompare(b.assetName));
  return entries;
}
