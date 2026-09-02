/**
 * Where a Unity input action is referenced from C#.
 *
 * The New Input System couples the asset to code through **strings** -- an
 * action renamed in `.inputactions` breaks `FindAction("Jump")` with no
 * compiler error and no runtime warning, just an action that stops firing. So
 * the editor has to maintain the reference edge the compiler refuses to.
 *
 * References are not all the same thing, and the UI groups them accordingly:
 * looking an action UP is different from the method that RUNS when it fires.
 * Resolving the second is a two-hop walk -- `jump = player.FindAction("Jump")`
 * ties a local to an action, `jump.performed += OnJump` ties that local to a
 * handler name, and `void OnJump(...)` is where the behaviour actually lives.
 * Answering "what happens when this fires?" means following all three.
 *
 * Two layers, split so the interesting half is testable:
 *   - `findActionReferencesInText` is PURE -- text in, positions out.
 *   - `buildActionReferenceIndex` walks the project and applies it.
 *
 * Deliberately no store imports (Tauri `invoke` only): the pure half runs under
 * Bun's DOM-less test runtime, where a transitive reach into `stores/theme.ts`
 * crashes the suite on import alone.
 */

import { invoke } from '@tauri-apps/api/core';

/** How a reference relates to the action. The UI groups on this. */
export type ActionRefKind =
  /** `player.FindAction("Jump")` -- looking the action up. */
  | 'find-action'
  /** `controls.actions["Player/Jump"]` -- the same, by indexer. */
  | 'indexer'
  /** `jump.performed += OnJump` -- attaching behaviour to the action. */
  | 'subscription'
  /** `void OnJump(...)` -- the behaviour itself. What runs when it fires. */
  | 'handler'
  /** `controls.FindActionMap("Player")` -- a map, not an action. */
  | 'find-map';

/** Kinds that answer "what happens when this fires?" rather than "where is it read?". */
export const BEHAVIOUR_KINDS: readonly ActionRefKind[] = ['handler'];

export interface ActionReference {
  filePath: string;
  /** 1-based, ready for `openExcerptAt`. */
  line: number;
  /** 1-based, points at the literal, the handler name, or the method name. */
  column: number;
  kind: ActionRefKind;
  /** Unqualified action name -- or the map name when `kind` is `find-map`. */
  actionName: string;
  /** `Map/Action` when the literal named a map, else null. */
  qualifiedName: string | null;
  /** The trimmed source line, shown in the reference list. */
  snippet: string;
  /** For a subscription or handler: the method that runs. */
  handler?: string;
  /** For a subscription: which phase it fires on. */
  phase?: string;
}

const FIND_ACTION_RE = /\bFindAction\s*\(\s*"([^"\n]*)"/g;
const INDEXER_RE = /\.\s*actions\s*\[\s*"([^"\n]*)"\s*\]/g;
const FIND_MAP_RE = /\bFindActionMap\s*\(\s*"([^"\n]*)"/g;
/** `jump = player.FindAction("Jump")` -- binds a local to an action name. */
const ACTION_ASSIGN_RE = /\b(\w+)\s*=\s*[^;\n]*?\bFindAction\s*\(\s*"([^"\n]*)"/g;
/** `jump.performed += OnJump` -- binds a local to the method that handles it. */
const SUBSCRIBE_RE = /\b(\w+)\s*\.\s*(performed|started|canceled)\s*\+=\s*([\w.]+)/g;
/**
 * A method declaration. Anchored on the return type so `jump.performed +=
 * OnJump` is read as a subscription, not as a second definition of `OnJump`.
 */
const METHOD_DECL_RE = /\b(?:void|async\s+void|IEnumerator)\s+(\w+)\s*\(/g;

/** Byte offset -> 1-based line/column, plus the line's own text. */
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
  return { line, column: offset - lineStart + 1, snippet: text.slice(lineStart, lineEnd).trim() };
}

/** Split `"Player/Jump"` into its parts; a bare name has no map. */
function splitQualified(literal: string): { map: string | null; action: string } {
  const slash = literal.lastIndexOf('/');
  return slash === -1
    ? { map: null, action: literal }
    : { map: literal.slice(0, slash), action: literal.slice(slash + 1) };
}

/**
 * Every reference in one file to one of `actionNames`.
 *
 * Filtering against the KNOWN action list is what makes the looser patterns
 * safe: an indexer lookup or an `OnX` method is only reported when `X` really
 * is an action in the project, so `label = "Jump the gap"` and
 * `void OnEnable()` stay quiet.
 */
export function findActionReferencesInText(
  filePath: string,
  text: string,
  actionNames: readonly string[],
): ActionReference[] {
  if (actionNames.length === 0) return [];
  const known = new Set(actionNames);
  const refs: ActionReference[] = [];

  const push = (
    offset: number,
    kind: ActionRefKind,
    actionName: string,
    extra: Partial<ActionReference> = {},
  ) => {
    const { line, column, snippet } = locate(text, offset);
    refs.push({
      filePath,
      line,
      column,
      kind,
      actionName,
      qualifiedName: null,
      snippet,
      ...extra,
    });
  };

  /** Literal lookups, and the local each one is assigned to. */
  const actionOfLocal = new Map<string, string>();

  for (const [re, kind] of [
    [FIND_ACTION_RE, 'find-action'],
    [INDEXER_RE, 'indexer'],
    [FIND_MAP_RE, 'find-map'],
  ] as const) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      const literal = m[1];
      const quote = m[0].indexOf('"');
      const offset = m.index + (quote === -1 ? 0 : quote);

      if (kind === 'find-map') {
        push(offset, kind, literal);
        continue;
      }
      const { map, action } = splitQualified(literal);
      if (!known.has(action)) continue;
      push(offset, kind, action, { qualifiedName: map === null ? null : literal });
    }
  }

  ACTION_ASSIGN_RE.lastIndex = 0;
  for (let m = ACTION_ASSIGN_RE.exec(text); m !== null; m = ACTION_ASSIGN_RE.exec(text)) {
    const { action } = splitQualified(m[2]);
    if (known.has(action)) actionOfLocal.set(m[1], action);
  }

  /** Handler name -> the action whose event it is attached to. */
  const actionOfHandler = new Map<string, string>();

  SUBSCRIBE_RE.lastIndex = 0;
  for (let m = SUBSCRIBE_RE.exec(text); m !== null; m = SUBSCRIBE_RE.exec(text)) {
    const [, local, phase, handler] = m;
    const action = actionOfLocal.get(local);
    if (!action) continue;
    actionOfHandler.set(handler, action);
    push(m.index + m[0].lastIndexOf(handler), 'subscription', action, { handler, phase });
  }

  // The method bodies. Two ways in: a handler we watched get subscribed, or
  // Unity's "Send Messages" convention where `OnJump` is wired by name alone.
  METHOD_DECL_RE.lastIndex = 0;
  for (let m = METHOD_DECL_RE.exec(text); m !== null; m = METHOD_DECL_RE.exec(text)) {
    const method = m[1];
    const subscribed = actionOfHandler.get(method);
    const byConvention = method.startsWith('On') && known.has(method.slice(2))
      ? method.slice(2)
      : undefined;
    const action = subscribed ?? byConvention;
    if (!action) continue;
    push(m.index + m[0].indexOf(method), 'handler', action, { handler: method });
  }

  return refs.sort((a, b) => a.line - b.line || a.column - b.column);
}

// -- Project-wide index -------------------------------------------------------

export interface ActionReferenceIndex {
  /** Keyed by unqualified action name -- the form every site resolves to. */
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
