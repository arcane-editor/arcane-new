/**
 * Computes a workspace-relative path for display/clipboard use (e.g. "Copy
 * Relative Path" context-menu actions in the explorer and tab bar).
 *
 * Strips the `workspacePath + '/'` prefix from an absolute path. Falls back
 * to the original absolute path when there is no workspace open or the path
 * isn't actually under the workspace root (e.g. a file outside the project).
 */
export function toRelativePath(absolutePath: string, workspacePath: string | null): string {
  if (!workspacePath) return absolutePath;
  const prefix = workspacePath.endsWith('/') ? workspacePath : `${workspacePath}/`;
  return absolutePath.startsWith(prefix) ? absolutePath.slice(prefix.length) : absolutePath;
}

/**
 * Is this path already anchored, rather than relative to something?
 *
 * The Windows half is not optional. Every path Rust hands the frontend goes
 * through `path_util::to_ui_path`, which rewrites separators but keeps the
 * path ABSOLUTE — so `unity_index_guid_map` answers `D:/Proj/Assets/UI/Theme.uss`
 * on Windows and `/Users/me/Proj/Assets/UI/Theme.uss` on macOS. A
 * `startsWith('/')` test calls the first of those relative and joins it onto
 * the workspace a second time, producing `D:/Proj/D:/Proj/Assets/...`, which no
 * `read_file` can open. That is a silent, platform-specific failure: the code
 * reads correctly, and it is correct — on the machine it was written on.
 */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path);
}

/**
 * The inverse of {@link toRelativePath}: anchor a possibly-relative path to the
 * workspace, leaving an already-absolute one untouched.
 *
 * Returns the path unchanged when there is no workspace open, which is the same
 * "nothing to anchor to" fallback `toRelativePath` takes.
 */
export function toAbsolutePath(path: string, workspacePath: string | null): string {
  if (!workspacePath || isAbsolutePath(path)) return path;
  const base = workspacePath.endsWith('/') ? workspacePath.slice(0, -1) : workspacePath;
  return `${base}/${path}`;
}
