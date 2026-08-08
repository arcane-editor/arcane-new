/**
 * Material Icon Theme resolution — pure lookup, no React and no stores.
 *
 * Kept separate from `file-icons.tsx` on purpose: that file binds these
 * results to React and to the theme store, and `stores/theme` reads
 * `window.localStorage` at module-eval time, which crashes under `bun test`'s
 * no-DOM environment. Importing *this* module pulls in nothing but a
 * generated data table, so the resolution rules stay unit-testable.
 * (Same split rationale as `services/attachments.ts`.)
 */

import {
  ICON_PATHS,
  FILE_NAMES,
  FILE_EXTENSIONS,
  FOLDER_NAMES,
  FOLDER_NAMES_EXPANDED,
  LIGHT_FILE_NAMES,
  LIGHT_FILE_EXTENSIONS,
  LIGHT_FOLDER_NAMES,
  LIGHT_FOLDER_NAMES_EXPANDED,
  DEFAULT_FILE,
  DEFAULT_FOLDER,
  DEFAULT_FOLDER_OPEN,
} from './material-icon-map.generated';

/**
 * Unity extensions upstream has no icon for.
 *
 * Material Icon Theme covers `.unity` and `.unitypackage` but nothing else in
 * Unity's asset family — `.prefab`, `.asset`, `.mat`, `.controller`,
 * `.asmdef`, `.anim`, `.meta`, `.uxml`, `.uss` all resolve to the generic file
 * icon upstream. In a Unity IDE those are the most-handled files in the tree,
 * so this overlay maps them onto icons that *do* exist in the vendored set.
 *
 * Consulted before the generated maps, so it also wins if upstream later adds
 * a conflicting entry — deliberate: this is the product's own vocabulary.
 * Every value here is asserted to exist in `ICON_PATHS` by the unit tests.
 */
const UNITY_EXTENSION_OVERRIDES: Record<string, string> = {
  prefab: 'unity',
  asset: 'unity',
  controller: 'unity',
  overridecontroller: 'unity',
  mat: 'unity',
  physicmaterial: 'unity',
  physicsmaterial: 'unity',
  anim: 'unity',
  mixer: 'unity',
  shadergraph: 'shader',
  shadersubgraph: 'shader',
  inputactions: 'settings',
  asmdef: 'settings',
  asmref: 'settings',
  uxml: 'xml',
  uss: 'css',
  // `.meta` is sidecar bookkeeping, never opened by hand — a muted, generic
  // mark keeps it from competing with its asset for attention in the tree.
  meta: 'document',
  // HDR/EXR light probes and lightmaps are images; upstream knows `exr` only.
  hdr: 'image',
  cubemap: 'image',
};

/**
 * Unity folders upstream has no icon for.
 *
 * Same gap as `UNITY_EXTENSION_OVERRIDES`, on the folder side: Material covers
 * `Scripts`, `Shaders`, `Textures`, `Animations` and `Resources`, but not
 * `Prefabs`, `Scenes`, `Materials`, `Editor` or `StreamingAssets` — five of the
 * folders in Unity's own standard project layout, which would otherwise all
 * render as the plain default folder.
 *
 * Values are base ids; the `-open` variant is derived, and both are asserted to
 * exist in `ICON_PATHS` by the unit tests.
 */
const UNITY_FOLDER_OVERRIDES: Record<string, string> = {
  prefabs: 'folder-unity',
  scenes: 'folder-unity',
  materials: 'folder-resource',
  streamingassets: 'folder-resource',
  scriptableobjects: 'folder-resource',
  // `Editor/` is Unity's build-excluded tooling directory, not a text editor.
  editor: 'folder-config',
};

/** Icon id → SVG filename, falling back to the default file icon. */
export function iconFileName(iconId: string): string {
  return ICON_PATHS[iconId] ?? ICON_PATHS[DEFAULT_FILE];
}

/** Public URL for an icon id, as served from `public/icons/material/`. */
export function iconUrl(iconId: string): string {
  return `/icons/material/${iconFileName(iconId)}`;
}

function pick(
  key: string,
  base: Record<string, string>,
  light: Record<string, string>,
  isLight: boolean,
): string | undefined {
  // Upstream ships dedicated `_light` variants only for icons that wash out on
  // light backgrounds, so the light map is a sparse overlay, not a replacement.
  if (isLight) {
    const l = light[key];
    if (l) return l;
  }
  return base[key];
}

/**
 * Resolves a filename to a Material icon id, in VS Code's order:
 *
 *   1. exact filename match
 *   2. compound extensions, **longest suffix first** — `auth.service.ts` tries
 *      `service.ts` before `ts`, which is the whole reason this file exists
 *   3. the default file icon
 */
export function resolveFileIconId(filename: string, isLight: boolean): string {
  const name = filename.toLowerCase();
  if (!name) return DEFAULT_FILE;

  const byName = pick(name, FILE_NAMES, LIGHT_FILE_NAMES, isLight);
  if (byName) return byName;

  const segments = name.split('.');
  // Start at 1 so the leading name segment is never treated as an extension,
  // and so a dotfile like `.gitignore` (segments `['', 'gitignore']`) still
  // probes `gitignore`. Ascending i yields longest-suffix-first.
  for (let i = 1; i < segments.length; i++) {
    const suffix = segments.slice(i).join('.');
    const override = UNITY_EXTENSION_OVERRIDES[suffix];
    if (override) return override;
    const byExt = pick(suffix, FILE_EXTENSIONS, LIGHT_FILE_EXTENSIONS, isLight);
    if (byExt) return byExt;
  }

  return DEFAULT_FILE;
}

/** Resolves a folder name to a Material icon id for the given open state. */
export function resolveFolderIconId(
  folderName: string,
  isOpen: boolean,
  isLight: boolean,
): string {
  const name = folderName.toLowerCase();
  const fallback = isOpen ? DEFAULT_FOLDER_OPEN : DEFAULT_FOLDER;
  if (!name) return fallback;

  const override = UNITY_FOLDER_OVERRIDES[name];
  if (override) return isOpen ? `${override}-open` : override;

  const hit = isOpen
    ? pick(name, FOLDER_NAMES_EXPANDED, LIGHT_FOLDER_NAMES_EXPANDED, isLight)
    : pick(name, FOLDER_NAMES, LIGHT_FOLDER_NAMES, isLight);

  return hit ?? fallback;
}
