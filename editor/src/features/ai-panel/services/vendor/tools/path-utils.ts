/**
 * Path utilities - adapted from PI coding agent
 * packages/coding-agent/src/core/tools/path-utils.ts
 *
 * Simplified for Tauri (no macOS screenshot hacks, no @ prefix).
 */

/**
 * Resolve a path relative to a working directory.
 * If the path is absolute, return it as-is.
 * If relative, join with cwd.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  if (isAbsolute(expanded)) {
    return normalizePath(expanded);
  }
  return normalizePath(joinPath(cwd, expanded));
}

/**
 * Expand ~ to home directory.
 */
function expandPath(filePath: string): string {
  if (filePath.startsWith('~/') || filePath === '~') {
    // In Tauri/browser context, we don't have process.env.HOME
    // The agent service will resolve ~ before calling tools
    return filePath;
  }
  return filePath;
}

function isAbsolute(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path);
}

function normalizePath(path: string): string {
  // Remove trailing slashes (except root)
  const normalized = path.replace(/\/+/g, '/');
  if (normalized.length > 1 && normalized.endsWith('/')) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

function joinPath(base: string, relative: string): string {
  if (base.endsWith('/')) {
    return base + relative;
  }
  return base + '/' + relative;
}

/**
 * Add line numbers to file content (1-indexed).
 */
export function addLineNumbers(content: string, startLine: number = 1): string {
  const lines = content.split('\n');
  const maxLineNum = startLine + lines.length - 1;
  const padding = String(maxLineNum).length;
  return lines
    .map((line, i) => `${String(startLine + i).padStart(padding, ' ')} | ${line}`)
    .join('\n');
}
