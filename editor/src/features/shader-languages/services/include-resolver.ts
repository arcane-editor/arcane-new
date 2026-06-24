import type { Monaco } from '@monaco-editor/react';
import type { editor, Position, languages } from 'monaco-editor';
import { invoke } from '@tauri-apps/api/core';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useProjectContextStore } from '../../../stores/project-context';

/**
 * Go-to-definition for `#include "..."` directives in shader files.
 *
 * Resolution strategy (first existing match wins):
 *   1. Relative path  → `<dir-of-current-file>/<path>`
 *   2. `Packages/<pkg>/...`
 *        a. embedded  → `<workspace>/Packages/<pkg>/...`
 *        b. cached    → `<workspace>/Library/PackageCache/<pkg>@<ver>/...`
 *                       (the `@<ver>` folder is discovered by listing the
 *                        PackageCache dir and matching a `<pkg>@` prefix)
 *   3. Built-in       → `<editorInstallPath>/Contents/CGIncludes/<name>` (macOS)
 *
 * Clicking the result opens the file through the LSP feature's editor opener
 * (registered globally); the Unity PackageCache read-only banner then applies
 * automatically based on the resolved path.
 *
 * Everything is best-effort: when `editorInstallPath` is null (no resolved
 * Unity editor) the built-in branch is skipped, and any missing file simply
 * yields no definition rather than an error.
 */

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

/** Directory portion of an absolute file path (no trailing slash). */
function dirOf(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx <= 0 ? '' : norm.slice(0, idx);
}

/** Strip the workspace path to a clean prefix (no trailing slash). */
function trimSlash(p: string): string {
  return p.replace(/\/+$/, '');
}

/**
 * Normalise a path containing `.`/`..` segments. Operates on `/`-separated
 * absolute paths (we always build absolute candidates before calling this).
 */
function normalizePath(p: string): string {
  const isAbs = p.startsWith('/');
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!isAbs) out.push('..');
    } else {
      out.push(seg);
    }
  }
  return (isAbs ? '/' : '') + out.join('/');
}

/** Does a file exist (and is readable)? `read_file` rejects on ENOENT. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await invoke<string>('read_file', { path });
    return true;
  } catch {
    return false;
  }
}

/**
 * Glob `<workspace>/Library/PackageCache/` for a directory whose name starts
 * with `<pkg>@` and return its absolute path, or null. Unity names cached
 * packages `name@version` (e.g. `com.unity.render-pipelines.universal@14.0.11`).
 */
async function findPackageCacheDir(
  workspacePath: string,
  pkg: string,
): Promise<string | null> {
  const cacheRoot = `${trimSlash(workspacePath)}/Library/PackageCache`;
  try {
    const entries = await invoke<FileEntry[]>('read_directory', { path: cacheRoot });
    const prefix = `${pkg}@`;
    const match = entries.find((e) => e.is_dir && e.name.startsWith(prefix));
    return match?.path ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve a `Packages/<pkg>/<rest...>` include path to an absolute file path:
 * try the embedded copy under `<workspace>/Packages/<pkg>` first, then the
 * versioned PackageCache folder. Returns the first that exists, or null.
 */
async function resolvePackagePath(
  workspacePath: string,
  includePath: string,
): Promise<string | null> {
  // includePath looks like: Packages/<pkg>/<sub/dirs/file.hlsl>
  const withoutPrefix = includePath.replace(/^Packages\//, '');
  const slash = withoutPrefix.indexOf('/');
  if (slash < 0) return null;
  const pkg = withoutPrefix.slice(0, slash);
  const rest = withoutPrefix.slice(slash + 1);

  // a) Embedded package under <workspace>/Packages/<pkg>/<rest>
  const embedded = normalizePath(`${trimSlash(workspacePath)}/Packages/${pkg}/${rest}`);
  if (await fileExists(embedded)) return embedded;

  // b) Cached package under Library/PackageCache/<pkg>@<ver>/<rest>
  const cacheDir = await findPackageCacheDir(workspacePath, pkg);
  if (cacheDir) {
    const cached = normalizePath(`${trimSlash(cacheDir)}/${rest}`);
    if (await fileExists(cached)) return cached;
  }

  return null;
}

/**
 * Resolve a bare built-in include name (e.g. `UnityCG.cginc`) under the
 * resolved editor install's CGIncludes. macOS layout: the install path is the
 * `.app` bundle, includes live at `<app>/Contents/CGIncludes/<name>`.
 * Returns null when no editor is resolved or the file is absent.
 */
async function resolveBuiltinInclude(name: string): Promise<string | null> {
  const editorInstallPath = useProjectContextStore.getState().editorInstallPath;
  if (!editorInstallPath) return null;
  const candidate = normalizePath(
    `${trimSlash(editorInstallPath)}/Contents/CGIncludes/${name}`,
  );
  return (await fileExists(candidate)) ? candidate : null;
}

/**
 * Resolve an include path string to an absolute target file path, applying the
 * full strategy (relative → Packages/ → built-in). Returns null if unresolved.
 */
async function resolveIncludeTarget(
  currentFilePath: string,
  includePath: string,
): Promise<string | null> {
  const trimmed = includePath.trim();
  if (!trimmed) return null;

  const workspacePath = useWorkspaceStore.getState().workspacePath;
  const baseDir = dirOf(currentFilePath);

  // 1) Relative resolution (against the current file's directory). This also
  //    covers `./foo.hlsl`, `../Shared/foo.cginc`, and bare same-dir names.
  if (baseDir) {
    const relative = normalizePath(`${baseDir}/${trimmed}`);
    if (await fileExists(relative)) return relative;
  }

  // 2) Packages/<pkg>/... (embedded or PackageCache glob).
  if (workspacePath && /^Packages\//.test(trimmed)) {
    const pkg = await resolvePackagePath(workspacePath, trimmed);
    if (pkg) return pkg;
  }

  // 3) Built-in CGIncludes — only for bare names (no path separators), which
  //    is how UnityCG.cginc / Lighting.cginc / AutoLight.cginc are included.
  if (!trimmed.includes('/')) {
    const builtin = await resolveBuiltinInclude(trimmed);
    if (builtin) return builtin;
  }

  return null;
}

/**
 * Extract the `#include "..."` path whose quotes span the cursor column.
 * Returns null when the cursor isn't on an include directive's path.
 */
function includePathAtPosition(
  model: editor.ITextModel,
  position: Position,
): string | null {
  const lineContent = model.getLineContent(position.lineNumber);
  if (!/#\s*include/.test(lineContent)) return null;

  // Find a quoted segment that contains the cursor column (1-based).
  const re = /"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lineContent)) !== null) {
    const openCol = m.index + 1; // column of opening quote (1-based)
    const closeCol = m.index + m[0].length; // column of closing quote
    // Accept the cursor anywhere from just after the opening quote through the
    // closing quote (inclusive) so clicks on the path resolve.
    if (position.column > openCol && position.column <= closeCol + 1) {
      return m[1];
    }
  }
  return null;
}

/**
 * Register a DefinitionProvider on the shader languages that resolves
 * `#include "..."` targets to openable file Locations. Returns a disposer.
 */
export function registerIncludeResolver(
  monaco: Monaco,
  shaderlabLangId: string,
  hlslLangId: string,
): () => void {
  const provider: languages.DefinitionProvider = {
    async provideDefinition(model: editor.ITextModel, position: Position) {
      const includePath = includePathAtPosition(model, position);
      if (!includePath) return null;

      const currentFilePath = decodeURIComponent(
        model.uri.toString().replace(/^file:\/\//, ''),
      );
      const target = await resolveIncludeTarget(currentFilePath, includePath);
      if (!target) return null;

      // Range at the top of the target file. monaco.Uri.file() produces the
      // canonical file:// encoding the global editor-opener decodes back.
      return {
        uri: monaco.Uri.file(target),
        range: {
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: 1,
        },
      };
    },
  };

  const disposables = [
    monaco.languages.registerDefinitionProvider(shaderlabLangId, provider),
    monaco.languages.registerDefinitionProvider(hlslLangId, provider),
  ];

  return () => {
    for (const d of disposables) d.dispose();
  };
}
