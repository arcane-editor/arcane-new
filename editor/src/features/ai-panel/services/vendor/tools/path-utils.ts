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
 *
 * `.` and `..` segments are collapsed so a relative path can't traverse out of
 * the resolved location (e.g. `../../etc/passwd`).
 */
export function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  const joined = isAbsolute(expanded) ? expanded : joinPath(cwd, expanded);
  return collapseDotSegments(normalizePath(joined));
}

/**
 * Raised when a path resolves outside the allowed root (the Assets sandbox for
 * Unity projects). Tools catch this and return a model-visible error result.
 */
export class PathOutsideRootError extends Error {
  constructor(
    readonly attemptedPath: string,
    readonly allowedRoot: string,
  ) {
    super(`Path '${attemptedPath}' is outside the allowed root '${allowedRoot}'`);
    this.name = 'PathOutsideRootError';
  }
}

/**
 * Like {@link resolveToCwd}, but when `allowedRoot` is non-null the resolved
 * path is required to live inside it (or equal it). Used to confine the AI's
 * file operations to the Assets/ folder in Unity projects. When `allowedRoot`
 * is null this behaves exactly like `resolveToCwd` (no sandbox).
 *
 * Containment is compared case-insensitively so projects on the default
 * case-insensitive macOS/Windows filesystems aren't tripped up by `assets/`
 * vs `Assets/`.
 */
export function resolveWithinRoot(
  filePath: string,
  cwd: string,
  allowedRoot: string | null,
): string {
  const resolved = resolveToCwd(filePath, cwd);
  if (!allowedRoot) return resolved;

  const root = collapseDotSegments(normalizePath(allowedRoot));
  const resolvedCmp = resolved.toLowerCase();
  const rootCmp = root.toLowerCase();
  if (resolvedCmp === rootCmp || resolvedCmp.startsWith(rootCmp + '/')) {
    return resolved;
  }
  throw new PathOutsideRootError(resolved, root);
}

/** Consistent, actionable message shown to the model when a path is blocked. */
export function pathOutsideRootMessage(err: PathOutsideRootError): string {
  return (
    `Error: '${err.attemptedPath}' is outside the allowed project area. ` +
    `In Unity projects, file operations are restricted to the Assets/ folder ` +
    `(${err.allowedRoot}). Use a path inside Assets/.`
  );
}

/**
 * Resolve `.` and `..` segments without touching the filesystem. `..` never
 * escapes past the root (a leading `..` on an absolute/relative path is
 * dropped). Operates on a slash-normalized path; preserves a POSIX leading `/`
 * or a Windows `C:` drive prefix.
 */
function collapseDotSegments(p: string): string {
  const path = p.replace(/\\/g, '/');
  const driveMatch = path.match(/^([a-zA-Z]:)\//);
  const drive = driveMatch ? driveMatch[1] : '';
  const isAbs = path.startsWith('/');
  const body = drive ? path.slice(drive.length) : path;

  const out: string[] = [];
  for (const seg of body.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(seg);
  }

  const joined = out.join('/');
  if (drive) return `${drive}/${joined}`;
  if (isAbs) return `/${joined}`;
  return joined;
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
