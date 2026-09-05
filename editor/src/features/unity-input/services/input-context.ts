// Everything about an `.inputactions` asset that does not live inside the asset.
//
// Two things, both of which change what the panel is allowed to claim:
//
//   1. Whether the asset generates a C# wrapper class, and what it is called.
//      Read from the `.meta`, because the importer settings live there rather
//      than in the JSON. Without it we cannot tell `controls.Player.Jump` from
//      any other property chain.
//
//   2. Whether any scene or prefab references the asset. If one does, an
//      `InputActionReference` may be wired in the Inspector, which leaves no
//      trace in C# at all -- so an action with no code reference has to be
//      reported as `unknown` rather than accused of being dead.
//
// The parsing half is pure and tested; only the two `invoke` calls are not.

import { invoke } from '@tauri-apps/api/core';
import type { WrapperInfo } from './input-graph';

export interface InputAssetMeta {
  guid: string | null;
  wrapper: WrapperInfo | null;
}

// `[^\S\r\n]` is horizontal whitespace ONLY. Plain `\s*` matches newlines, so
// `wrapperClassName:\n  wrapperCodeNamespace:` captured the NEXT line's text as
// the class name -- the same trap `unity_yaml.rs` documents on its own
// separator regex. Unity writes these keys with a trailing space and an empty
// value, which is precisely the shape that triggers it.
const H = '[^\\S\\r\\n]*';
const GUID_RE = new RegExp(`^${H}guid:${H}([0-9a-fA-F]{32})${H}$`, 'm');
const GENERATE_RE = new RegExp(`^${H}generateWrapperCode:${H}(\\d+)${H}$`, 'm');
const CLASS_RE = new RegExp(`^${H}wrapperClassName:${H}(.*)$`, 'm');
const PATH_RE = new RegExp(`^${H}wrapperCodePath:${H}(.*)$`, 'm');

/** File stem of an asset path: `Assets/UI/Controls.inputactions` -> `Controls`. */
export function assetStem(assetPath: string): string {
  const file = assetPath.split('/').pop() ?? assetPath;
  const dot = file.lastIndexOf('.');
  return dot === -1 ? file : file.slice(0, dot);
}

/**
 * Parse an `.inputactions.meta`.
 *
 * `wrapperClassName` is frequently EMPTY even when generation is on — Unity
 * then names the class after the asset file. Treating empty as "no wrapper"
 * would leave the most common configuration undetected, which is exactly the
 * blind spot this feature exists to close.
 */
export function parseInputMeta(text: string, assetPath: string): InputAssetMeta {
  const guid = GUID_RE.exec(text)?.[1]?.toLowerCase() ?? null;
  const generates = (GENERATE_RE.exec(text)?.[1] ?? '0') !== '0';
  if (!generates) return { guid, wrapper: null };

  const declared = (CLASS_RE.exec(text)?.[1] ?? '').trim();
  const path = (PATH_RE.exec(text)?.[1] ?? '').trim();
  return {
    guid,
    wrapper: {
      className: declared !== '' ? declared : assetStem(assetPath),
      path: path !== '' ? path : null,
    },
  };
}

/** A scene or prefab is the only kind of hit that implies Inspector wiring. */
export function referencedByScene(paths: readonly string[]): boolean {
  return paths.some((p) => {
    const lower = p.toLowerCase();
    return lower.endsWith('.unity') || lower.endsWith('.prefab');
  });
}

export interface InputAssetContext {
  wrapper: WrapperInfo | null;
  assetReferencedByScene: boolean;
}

const EMPTY: InputAssetContext = { wrapper: null, assetReferencedByScene: false };

interface RefHit {
  path: string;
  count: number;
}

/**
 * Load the context for one asset. Never throws: a project without the Unity
 * index, or an asset with no `.meta` yet, yields the neutral context — which
 * makes the panel quieter, never louder.
 */
export async function loadInputAssetContext(
  assetPath: string,
  workspacePath: string | null,
): Promise<InputAssetContext> {
  let meta: InputAssetMeta;
  try {
    const text = await invoke<string>('read_file', { path: `${assetPath}.meta` });
    meta = parseInputMeta(text, assetPath);
  } catch {
    return EMPTY;
  }

  if (!meta.guid || !workspacePath) {
    return { wrapper: meta.wrapper, assetReferencedByScene: false };
  }

  try {
    const hits = await invoke<RefHit[]>('unity_index_find_references', {
      workspacePath,
      guid: meta.guid,
    });
    return {
      wrapper: meta.wrapper,
      assetReferencedByScene: referencedByScene(hits.map((h) => h.path)),
    };
  } catch {
    // The index may not be built. Absence of evidence is not evidence of
    // absence, so claim nothing.
    return { wrapper: meta.wrapper, assetReferencedByScene: false };
  }
}
