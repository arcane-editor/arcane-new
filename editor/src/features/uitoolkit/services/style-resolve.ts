// Resolving `<Style src="...">` to a file on disk.
//
// Four forms appear in real projects and only two are obvious:
//
//   project://database/Assets/UI/Theme.uss?fileID=..&guid=<32hex>&type=3#Theme
//   project://database/Packages/com.unity.x/Editor/HelpButton.uss
//   Theme.uss                       (relative to the .uxml)
//   path="Styles/Theme"             (Resources-relative, no extension)
//
// The guid form is preferred wherever present: it survives the asset being
// moved, which the path does not. `parseStyleRef` already handles the
// `&amp;`-escaping that makes a naive query parse find no guid at all.
//
// The path arithmetic is pure and takes `resolveGuid` as a callback, so it is
// testable without a store or a Tauri bridge.

import { invoke } from '@tauri-apps/api/core';
import { parseStyleRef, type UxmlDocument } from '../../../utils/uxml-model';
import { parseUss, type UssStyleSheet } from '../../../utils/uss-model';

// NO store imports. `stores/unity-index` transitively reaches `stores/theme`,
// which touches `document.documentElement` at module scope and takes the whole
// Bun suite down on import alone -- the exact failure
// `unity-input/services/action-refs.ts` documents. The guid lookup is injected
// by the component, which is where store access belongs anyway.

/** Directory of a project-relative path. */
function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** Collapse `a/b/../c` and `./`. */
export function normalisePath(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

export interface ResolvedHref {
  /** Workspace-relative path, or null when it could not be resolved. */
  path: string | null;
  /** Why it could not be, for the honesty strip. */
  reason: string | null;
}

/**
 * Turn one `<Style>` reference into a workspace-relative path.
 *
 * `resolveGuid` maps a 32-hex guid to a path; pass whatever the index provides.
 */
export function resolveStyleHref(
  raw: string,
  kind: 'src' | 'path',
  uxmlPath: string,
  resolveGuid: (guid: string) => string | null,
): ResolvedHref {
  if (kind === 'path') {
    // Resources-relative and extension-less. Locating it needs a scan of every
    // `Resources/` folder, which the thin slice does not do.
    return {
      path: null,
      reason: `<Style path="${raw}"> is Resources-relative; that form is not resolved yet.`,
    };
  }

  const ref = parseStyleRef(raw);

  if (ref.guid) {
    const byGuid = resolveGuid(ref.guid);
    if (byGuid) return { path: byGuid, reason: null };
  }

  if (ref.path === null || ref.path === '') {
    return { path: null, reason: `Could not read a path out of "${raw}".` };
  }

  if (ref.kind === 'project') {
    // Already workspace-relative: `Assets/...` or `Packages/...`.
    return { path: normalisePath(ref.path), reason: null };
  }

  // Relative to the document that named it.
  const dir = dirOf(uxmlPath);
  return { path: normalisePath(dir === '' ? ref.path : `${dir}/${ref.path}`), reason: null };
}

export interface LoadedStyles {
  sheets: UssStyleSheet[];
  /** One entry per stylesheet we could not read. */
  unresolved: string[];
}

/**
 * Read every stylesheet a document attaches.
 *
 * Uses per-file `read_file` rather than `read_files_bulk` on purpose: the bulk
 * command silently drops anything unreadable, and a stylesheet vanishing without
 * a word is the opposite of what this preview is for. The count is at most a
 * handful.
 */
export async function loadStyleSheets(
  doc: UxmlDocument,
  uxmlPath: string,
  workspacePath: string | null,
  lookupGuid: (guid: string) => Promise<string | null>,
): Promise<LoadedStyles> {
  const sheets: UssStyleSheet[] = [];
  const unresolved: string[] = [];
  if (!workspacePath) return { sheets, unresolved };

  // `lookupGuid` is async and `resolveStyleHref` is sync so it stays testable,
  // so resolve every guid up front and hand the resolver a plain map lookup.
  const guidPaths = new Map<string, string>();
  for (const ref of doc.styleRefs) {
    const guid = parseStyleRef(ref.raw).guid;
    if (!guid || guidPaths.has(guid)) continue;
    try {
      const hit = await lookupGuid(guid);
      if (hit) guidPaths.set(guid, hit);
    } catch {
      // No index yet. The path fallback below still applies.
    }
  }
  const resolveGuid = (guid: string) => guidPaths.get(guid) ?? null;

  for (const ref of doc.styleRefs) {
    const { path, reason } = resolveStyleHref(ref.raw, ref.kind, uxmlPath, resolveGuid);
    if (!path) {
      unresolved.push(reason ?? ref.raw);
      continue;
    }
    const absolute = path.startsWith('/') ? path : `${workspacePath}/${path}`;
    try {
      const content = await invoke<string>('read_file', { path: absolute });
      sheets.push(parseUss(content, path));
    } catch {
      unresolved.push(
        path.startsWith('Packages/')
          ? `${path} — a registry package's files live under Library/PackageCache, which is not resolved yet.`
          : `${path} could not be read.`,
      );
    }
  }

  return { sheets, unresolved };
}
