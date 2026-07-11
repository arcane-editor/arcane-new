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
