/**
 * Humanized tool-call titles (P5.1) — pure, store-free mapping from a raw
 * `(toolName, args)` pair (+ optional live status, for diff line counts; +
 * optional workspacePath, for path relativization) to a short human-readable
 * `{ title, subtitle? }`, replacing the raw tool name + `JSON.stringify(arguments)`
 * `ToolCallBlock` used to show by default.
 *
 * Path display: the system prompt (`prompts/agent.ts`: "All file paths are
 * relative to this project root unless absolute paths are given") means
 * `args.path` is USUALLY already workspace-relative (e.g. "Assets/Scripts/
 * Player.cs") — but the write/edit/list tool schemas explicitly document
 * `path` as "Absolute or relative" and echo whatever the model supplied
 * straight back in their text result, so a model can (and in practice does)
 * pass, or later reuse, an absolute path (review finding: a full filesystem
 * path like `/Users/dev/MyProj/Assets/Scripts/Player.cs` rendering verbatim
 * in the header). `workspacePath` (optional, 4th param — `ToolCallBlock`
 * passes it from `useWorkspaceStore`) lets this module relativize an
 * absolute `args.path` the same case-tolerant way `lsp-gate.ts`'s
 * `toRelativePath` does; see `relativizePath` below for the exact fallback
 * when the path isn't under the known workspace root. This module still does
 * NOT try to relativize `status.diffs[].path` (which IS always absolute —
 * see `diff-decorator.ts` — but is never rendered by this module, only fed to
 * the +/- counter).
 *
 * +/- counts are computed from the `diff` package's `structuredPatch(...)`
 * hunks, whose lines carry an unambiguous single-char prefix (`' '|'+'|'-'`)
 * in a dedicated array field — NOT by re-parsing a joined patch string, which
 * is ambiguous: an added line whose CONTENT starts with `++` (e.g. `++i;`)
 * serializes to a patch line reading `+++i;`, indistinguishable by
 * string-prefix from a `+++ filename` file header (review finding — the
 * previous implementation silently dropped such lines as "headers").
 *
 * Unrecognized tool names (the `default` branch) return the name unchanged —
 * for any tool whose "name" is already a human-readable title, falling through
 * to "name as-is" is the correct rendering, not a gap.
 */

import { structuredPatch } from 'diff';

export interface HumanizeDiff {
  path: string;
  oldText: string;
  newText: string;
}

/** Structural subset of `stores/ai.ts`'s `ToolCallStatus` — only what this module needs. */
export interface HumanizeStatus {
  diffs?: HumanizeDiff[];
}

export interface HumanizedToolCall {
  title: string;
  subtitle?: string;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

function basename(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx === -1 ? norm : norm.slice(idx + 1);
}

function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p);
}

/**
 * Relativize an absolute `args.path` against the workspace root, the same
 * case-tolerant way `lsp-gate.ts`'s `toRelativePath` does (macOS/Windows
 * default to case-insensitive filesystems, so a workspace opened as
 * `/Users/x/Proj` should still match a model-supplied `/users/x/proj/...`).
 * A relative path is returned unchanged — the common case. An absolute path
 * that ISN'T under the known root, or when no `workspacePath` was passed at
 * all, falls back to just the basename: not the literal path the model
 * wrote, but strictly better than rendering a full absolute filesystem path,
 * and consistent with `humanizeRead` already only ever showing a basename.
 */
function relativizePath(path: string, workspacePath?: string): string {
  if (!isAbsolutePath(path)) return path;
  if (workspacePath) {
    const normRoot = (workspacePath.endsWith('/') ? workspacePath : `${workspacePath}/`).toLowerCase();
    if (path.toLowerCase().startsWith(normRoot)) return path.slice(normRoot.length);
  }
  return basename(path);
}

function argPath(args: Record<string, unknown>, workspacePath?: string): string {
  if (typeof args.path !== 'string' || args.path.trim() === '') return '(unknown file)';
  return relativizePath(args.path, workspacePath);
}

/**
 * Line-arithmetic +/- count via `structuredPatch`'s hunks — each hunk line
 * has an unambiguous single-char prefix (index 0 is ' '/'+'/'-'), so this
 * can't misread an added/removed line whose own content happens to start
 * with '+' or '-' as a patch-header line (see this module's header).
 */
function countChangedLines(oldText: string, newText: string): { added: number; removed: number } {
  const { hunks } = structuredPatch('file', 'file', oldText, newText);
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line[0] === '+') added++;
      else if (line[0] === '-') removed++;
    }
  }
  return { added, removed };
}

function diffCountsSuffix(diffs: HumanizeDiff[] | undefined): string {
  if (!diffs || diffs.length === 0) return '';
  let added = 0;
  let removed = 0;
  for (const d of diffs) {
    const c = countChangedLines(d.oldText, d.newText);
    added += c.added;
    removed += c.removed;
  }
  if (added === 0 && removed === 0) return '';
  return ` (+${added} −${removed})`;
}

function humanizeWriteOrEdit(
  verb: 'Wrote' | 'Edited',
  args: Record<string, unknown>,
  status: HumanizeStatus | undefined,
  workspacePath: string | undefined,
): HumanizedToolCall {
  return { title: `${verb} ${argPath(args, workspacePath)}${diffCountsSuffix(status?.diffs)}` };
}

function humanizeRead(args: Record<string, unknown>): HumanizedToolCall {
  return { title: `Read ${basename(argPath(args))}` };
}

function humanizeList(args: Record<string, unknown>, workspacePath: string | undefined): HumanizedToolCall {
  const rawPath = typeof args.path === 'string' && args.path.trim() !== '' ? args.path : null;
  const path = rawPath ? relativizePath(rawPath, workspacePath) : null;
  return { title: path ? `Listed ${path}` : 'Listed workspace root' };
}

function humanizeBash(args: Record<string, unknown>): HumanizedToolCall {
  const raw = typeof args.command === 'string' ? args.command : '';
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  const shown = truncate(oneLine, 60);
  const lostInfo = raw.includes('\n') || oneLine.length > 60;
  return { title: `Ran \`${shown}\``, subtitle: lostInfo ? raw : undefined };
}

function humanizeTodo(args: Record<string, unknown>): HumanizedToolCall {
  const items = Array.isArray(args.items)
    ? (args.items as Array<{ status?: unknown }>)
    : [];
  const total = items.length;
  const done = items.filter((i) => i && i.status === 'done').length;
  return { title: `Updated todo list (${done}/${total} done)` };
}

// ---- Unity tools (F-5.2 / F-5.6) ----

const UNITY_STATIC_LABELS: Record<string, string> = {
  // Engine-mutate tools (unity-tools/mutate-tools.ts)
  unity_play: 'Entered Play Mode',
  unity_stop: 'Exited Play Mode',
  unity_refresh: 'Refreshed Unity assets',
  unity_console_clear: 'Cleared Unity console',
  // Bridge/index-backed read tools (unity-tools/read-tools.ts, script-map-tool.ts)
  get_console_errors: 'Checked Unity console',
  get_compile_errors: 'Checked Unity compile status',
  get_editor_state: 'Checked Unity editor state',
  get_scene_hierarchy: 'Read Unity scene hierarchy',
  get_game_object: 'Inspected a Unity GameObject',
  find_asset_references: 'Searched asset references',
  get_unity_script_map: 'Mapped Unity scripts',
  // Subsystem tools (scriptable-objects-tool.ts, ui-toolkit-tool.ts,
  // input-actions-tool.ts, so-drift-tool.ts, input-edit-tool.ts) — read/write
  // an asset format the generic read/write tools do not understand.
  unity_scriptable_objects: 'Read ScriptableObjects',
  unity_ui_toolkit: 'Read UI Toolkit setup',
  unity_input_actions: 'Read input actions',
  unity_fix_so_drift: 'Repaired ScriptableObject drift',
  unity_input_edit: 'Edited input actions',
};

function humanizeUnity(name: string, args: Record<string, unknown>): HumanizedToolCall {
  const staticLabel = UNITY_STATIC_LABELS[name];
  if (staticLabel) return { title: staticLabel };

  switch (name) {
    case 'unity_run_tests': {
      const mode = typeof args.mode === 'string' ? args.mode : 'EditMode';
      const filter = typeof args.filter === 'string' && args.filter ? args.filter : undefined;
      return { title: `Ran ${mode} tests${filter ? ` (filter: ${truncate(filter, 30)})` : ''}` };
    }
    case 'unity_execute_menu_item': {
      const path = typeof args.path === 'string' ? args.path : '';
      return { title: `Executed menu item "${truncate(path, 40)}"` };
    }
    case 'unity_api_search': {
      const query =
        typeof args.query === 'string'
          ? args.query
          : typeof args.member === 'string'
            ? args.member
            : '';
      return { title: `Searched Unity docs: ${truncate(query, 40)}` };
    }
    case 'get_unity_docs': {
      const symbol = typeof args.symbol === 'string' ? args.symbol : '';
      return { title: `Searched Unity docs: ${truncate(symbol, 40)}` };
    }
    case 'unity_plan_migration': {
      const kind = typeof args.kind === 'string' ? args.kind : '';
      return { title: `Planned Unity migration${kind ? ` (${kind})` : ''}` };
    }
    case 'unity_attach_ui_document': {
      const gameObject = typeof args.gameObject === 'string' && args.gameObject.trim() !== '' ? args.gameObject : undefined;
      return { title: gameObject ? `Attached UIDocument to "${truncate(gameObject, 40)}"` : 'Attached a UIDocument' };
    }
    case 'unity_set_property': {
      const property = typeof args.property === 'string' && args.property.trim() !== '' ? args.property : undefined;
      const component = typeof args.component === 'string' && args.component.trim() !== '' ? args.component : undefined;
      return { title: property ? `Set ${component ? `${component}.` : ''}${property}` : 'Set a Unity property' };
    }
    case 'unity_ui_write': {
      const path = typeof args.path === 'string' && args.path.trim() !== '' ? args.path : undefined;
      return { title: path ? `Wrote UI file ${basename(path)}` : 'Wrote a UI file' };
    }
    case 'unity_ui_layout': {
      const document = typeof args.document === 'string' && args.document.trim() !== '' ? args.document : undefined;
      return { title: document ? `Previewed layout of ${basename(document)}` : 'Previewed a UI layout' };
    }
    case 'unity_ui_scaffold': {
      const screen = typeof args.screen === 'string' && args.screen.trim() !== '' ? args.screen : undefined;
      return { title: screen ? `Drafted a ${screen} screen` : 'Drafted a UI screen' };
    }
    case 'unity_asset_edit': {
      const path = typeof args.path === 'string' && args.path.trim() !== '' ? args.path : undefined;
      return { title: path ? `Edited Unity asset ${basename(path)}` : 'Edited a Unity asset' };
    }
    default:
      return { title: name };
  }
}

const UNITY_TOOL_NAMES = new Set([
  ...Object.keys(UNITY_STATIC_LABELS),
  'unity_run_tests',
  'unity_execute_menu_item',
  'unity_api_search',
  'get_unity_docs',
  'unity_plan_migration',
  'unity_attach_ui_document',
  'unity_set_property',
  'unity_ui_write',
  'unity_ui_layout',
  'unity_ui_scaffold',
  'unity_asset_edit',
]);

/**
 * Map a raw tool call to a short, human-readable `{ title, subtitle? }` for
 * `ToolCallBlock`'s header. `status` (live/complete tool-call state,
 * `stores/ai.ts`'s `ToolCallStatus`) is optional — a just-started call has
 * none yet, and write/edit titles simply omit the +/- suffix until it arrives.
 * `workspacePath` (optional) is used to relativize an absolute `args.path` —
 * see this module's header.
 */
export function humanizeToolCall(
  name: string,
  args: Record<string, unknown>,
  status?: HumanizeStatus,
  workspacePath?: string,
): HumanizedToolCall {
  switch (name) {
    case 'write':
      return humanizeWriteOrEdit('Wrote', args, status, workspacePath);
    case 'edit':
      return humanizeWriteOrEdit('Edited', args, status, workspacePath);
    case 'read':
      return humanizeRead(args);
    case 'list':
      return humanizeList(args, workspacePath);
    case 'bash':
      return humanizeBash(args);
    case 'todo_update':
      return humanizeTodo(args);
    default:
      if (name.startsWith('graphify_')) return { title: 'Queried code graph' };
      if (UNITY_TOOL_NAMES.has(name)) return humanizeUnity(name, args);
      return { title: name };
  }
}
