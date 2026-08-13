// Which files a Unity PROGRAMMER is not searching for.
//
// A blocklist, deliberately, not an allowlist. An earlier version of this
// feature sent `fileExtensions: ['cs']` for Unity projects, which made
// shaders, .asmdef, .uxml and every YAML asset unsearchable — and because the
// backend ANDs fileExtensions with the include glob, no include pattern could
// widen it back. A blocklist composes with the user's own patterns and leaves
// unknown file types searchable, including ones Unity has not invented yet.
//
// The list is short because the search root for a Unity project is already
// `assetsRootPath`: Library/, Temp/, obj/, *.csproj and *.sln sit outside it
// and were never being searched.
//
// Matching is CASE-SENSITIVE: the backend builds these globs with the Rust
// `globset` crate's `Glob::new`, which has no case-insensitive option, so
// `**/*.prefab` does not match a file named `Foo.Prefab`. Unity itself always
// writes these extensions lowercase, so this is a non-issue for
// Unity-generated files — it only lets a user-renamed file with different
// casing slip through the filter.

/** Unity's YAML asset formats, plus the .meta sidecar every asset carries.
 *  All are text, so the backend's binary detection does not skip them — they
 *  match a plain-text query and bury real code hits. */
export const UNITY_NOISE_EXTENSIONS = [
  'meta',
  'unity',
  'prefab',
  'asset',
  'mat',
  'anim',
  'controller',
  'overrideController',
  'playable',
  'mixer',
  'preset',
  'terrainlayer',
  'spriteatlas',
  'guiskin',
  'fontsettings',
  'physicMaterial',
  'physicsMaterial2D',
  'shadervariants',
  'mask',
  'lighting',
] as const;

/** Exclude globs for the above, in the form the backend's globset expects
 *  (matched against a path relative to the search root). A fresh array per
 *  call — these are appended to a caller's own exclude list. */
export function unityNoiseExcludes(): string[] {
  return UNITY_NOISE_EXTENSIONS.map((ext) => `**/*.${ext}`);
}
