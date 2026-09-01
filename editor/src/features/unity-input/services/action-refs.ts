/**
 * Where a Unity input action is referenced from C#.
 *
 * The New Input System couples the asset to code through **strings** — an
 * action renamed in `.inputactions` breaks `FindAction("Jump")` with no
 * compiler error and no runtime warning, just an action that stops firing. So
 * the editor has to maintain the reference edge the compiler refuses to.
 *
 * Two layers, split so the interesting half is testable:
 *   - `findActionReferencesInText` is PURE — text in, positions out.
 *   - `buildActionReferenceIndex` walks the project and applies it.
 *
 * Deliberately no store imports (Tauri `invoke` only): the pure half is
 * exercised under Bun's DOM-less test runtime, and a transitive reach into
 * `stores/theme.ts` would crash the suite on import alone. Callers own cache
 * invalidation — key it on `useUnityIndexStore`'s `indexRevision`.
 */

import { invoke } from '@tauri-apps/api/core';

/** How a reference addresses the action. Each has a different rename fix-up. */
export type ActionRefKind =
  /** `player.FindAction("Jump")` */
  | 'find-action'
  /** `controls.actions["Player/Jump"]` */
  | 'indexer'
  /** `void OnJump(...)` — the PlayerInput "Send Messages" naming convention. */
  | 'handler'
  /** `controls.FindActionMap("Player")` — a map, not an action. */
  | 'find-map';

export interface ActionReference {
  filePath: string;
  /** 1-based, ready for `openExcerptAt`. */
  line: number;
  /** 1-based, points at the literal (or the method name for a handler). */
  column: number;
  kind: ActionRefKind;
  /** Unqualified action name — or the map name when `kind` is `find-map`. */
  actionName: string;
  /** `Map/Action` when the literal named a map, else null. */
  qualifiedName: string | null;
  /** The trimmed source line, shown in the peek list. */
  snippet: string;
}

interface RawMatch {
  offset: number;
  kind: ActionRefKind;
  literal: string;
}

const FIND_ACTION_RE = /\bFindAction\s*\(\s*"([^"]*)"/g;
const FIND_MAP_RE = /\bFindActionMap\s*\(\s*"([^"]*)"/g;
const INDEXER_RE = /\[\s*"([^"]*)"\s*\]/g;
/**
 * A handler is only recognised on a real method declaration. Matching bare
 * `OnJump` would also catch `jump.performed += OnJump`, which is a delegate
 * reference to the same method rather than a second definition site.
 */
const HANDLER_RE = /\bvoid\s+(On[A-Za-z_]\w*)\s*\(/g;

/** Byte offset → 1-based line/column, plus the line's own text. */
function locate(text: string, offset: number): { line: number; column: number; snippet: string } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  let lineEnd = text.indexOf('\n', lineStart);
  if (lineEnd === -1) lineEnd = text.length;
  return {
    line,
    column: offset - lineStart + 1,
    snippet: text.slice(lineStart, lineEnd).trim(),
  };
}

function collect(text: string, re: RegExp, kind: ActionRefKind, anchor: string): RawMatch[] {
  const out: RawMatch[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const within = m[0].indexOf(anchor === 'quote' ? '"' : m[1]);
    out.push({ offset: m.index + (within === -1 ? 0 : within), kind, literal: m[1] });
  }
  return out;
}

/**
 * Every reference in one file to one of `actionNames`.
 *
 * Filtering against the KNOWN action list is what makes the looser patterns
 * safe: an indexer lookup or an `OnX` method is only reported when `X` is
 * really an action in the project, so `label = "Jump the gap"` and
 * `void OnEnable()` stay quiet.
 */
export function findActionReferencesInText(
  filePath: string,
  text: string,
  actionNames: readonly string[],
): ActionReference[] {
  if (actionNames.length === 0) return [];
  const known = new Set(actionNames);

  const raw: RawMatch[] = [
    ...collect(text, FIND_ACTION_RE, 'find-action', 'quote'),
    ...collect(text, FIND_MAP_RE, 'find-map', 'quote'),
    ...collect(text, INDEXER_RE, 'indexer', 'quote'),
    ...collect(text, HANDLER_RE, 'handler', 'name'),
  ];

  const refs: ActionReference[] = [];
  for (const match of raw) {
    let actionName: string;
    let qualifiedName: string | null = null;

    if (match.kind === 'handler') {
      actionName = match.literal.slice(2); // strip the `On` prefix
    } else if (match.kind === 'find-map') {
      actionName = match.literal;
    } else {
      const slash = match.literal.lastIndexOf('/');
      actionName = slash === -1 ? match.literal : match.literal.slice(slash + 1);
      if (slash !== -1) qualifiedName = match.literal;
    }

    // A map literal is checked against nothing here: the caller wants map
    // sites regardless, and `FindActionMap` is unambiguous on its own.
    if (match.kind !== 'find-map' && !known.has(actionName)) continue;

    const { line, column, snippet } = locate(text, match.offset);
    refs.push({ filePath, line, column, kind: match.kind, actionName, qualifiedName, snippet });
  }

  return refs.sort((a, b) => a.line - b.line || a.column - b.column);
}

// ── Project-wide index ───────────────────────────────────────────────────────

export interface ActionReferenceIndex {
  /** Keyed by unqualified action name — the form every site resolves to. */
  byActionName: Map<string, ActionReference[]>;
  scannedFiles: number;
}

/** Unity noise that can never contain project scripts. */
const SCAN_EXCLUDES = ['Library/**', 'Temp/**', 'obj/**', 'Logs/**', 'Build/**', 'Builds/**'];
/** `read_files_bulk` takes the whole list; chunking keeps one payload sane. */
const READ_CHUNK = 400;

interface FileContent {
  path: string;
  content: string;
}

/**
 * Scan the project's C# for references to `actionNames`.
 *
 * Best-effort: an unreadable file is skipped by the Rust side rather than
 * failing the scan, and a failed walk yields an empty index so the UI shows
 * "no references found" instead of an error.
 */
export async function buildActionReferenceIndex(
  workspacePath: string,
  actionNames: readonly string[],
): Promise<ActionReferenceIndex> {
  const byActionName = new Map<string, ActionReference[]>();
  if (actionNames.length === 0) return { byActionName, scannedFiles: 0 };

  let paths: string[];
  try {
    paths = await invoke<string[]>('scan_all_files_v2', {
      workspacePath,
      extraExcludes: SCAN_EXCLUDES,
    });
  } catch {
    return { byActionName, scannedFiles: 0 };
  }

  const csharp = paths.filter((p) => p.endsWith('.cs'));
  let scannedFiles = 0;

  for (let i = 0; i < csharp.length; i += READ_CHUNK) {
    const chunk = csharp.slice(i, i + READ_CHUNK);
    let files: FileContent[];
    try {
      files = await invoke<FileContent[]>('read_files_bulk', { paths: chunk });
    } catch {
      continue;
    }
    for (const file of files) {
      scannedFiles++;
      for (const ref of findActionReferencesInText(file.path, file.content, actionNames)) {
        const list = byActionName.get(ref.actionName);
        if (list) list.push(ref);
        else byActionName.set(ref.actionName, [ref]);
      }
    }
  }

  return { byActionName, scannedFiles };
}
