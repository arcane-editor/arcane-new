/**
 * One-time migration for paths persisted by builds that predate the Rust-side
 * `path_util` normalization.
 *
 * Those builds stored the raw output of `std::fs::canonicalize`, which on
 * Windows carries the verbatim `\\?\` prefix. Such entries render as
 * `\\?\D:\...` in the recents list and, because dedup is an exact string
 * match, sit alongside the normalized path the same project produces now.
 * Applied at `hydratePersistence` time so the stored state is upgraded once
 * rather than being special-cased at every read.
 *
 * Mirrors `src-tauri/src/path_util.rs` — the Rust side remains the authority
 * for newly produced paths; this only repairs what is already on disk.
 */

/** `\\?\...`, `\\server\...`, or `C:\...` / `C:/...`. */
function looksWindowsNative(path: string): boolean {
  return path.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(path);
}

export function normalizeLegacyPath(path: string): string;
export function normalizeLegacyPath(path: string | null): string | null;
export function normalizeLegacyPath(path: string | null | undefined): string | null | undefined;
export function normalizeLegacyPath(
  path: string | null | undefined,
): string | null | undefined {
  if (!path) return path;
  // Guard: a backslash is a legal file-name character on macOS/Linux, so only
  // rewrite strings that are recognisably Windows-native. This also skips
  // virtual tab paths (`diff://`, `auth://`), which are not filesystem paths.
  if (!looksWindowsNative(path)) return path;

  let unprefixed: string;
  if (path.startsWith('\\\\?\\UNC\\')) {
    // Verbatim UNC: `\\?\UNC\srv\share` denotes `\\srv\share`.
    unprefixed = '\\\\' + path.slice('\\\\?\\UNC\\'.length);
  } else if (path.startsWith('\\\\?\\')) {
    unprefixed = path.slice('\\\\?\\'.length);
  } else {
    unprefixed = path;
  }
  // split/join rather than replaceAll — the tsconfig lib target predates it.
  return unprefixed.split('\\').join('/');
}
