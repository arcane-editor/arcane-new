/**
 * Humanized tool-call titles (P5.1) — pure, store-free mapping from a raw
 * `(toolName, args)` pair (+ optional live status, for diff line counts) to a
 * short human-readable `{ title, subtitle? }`, replacing the raw tool name +
 * `JSON.stringify(arguments)` `ToolCallBlock` used to show by default.
 *
 * Path display: tool args carry whatever path the model wrote, and the
 * system prompt (`prompts/agent.ts`: "All file paths are relative to this
 * project root unless absolute paths are given") means that in the normal
 * case `args.path` is ALREADY workspace-relative (e.g. "Assets/Scripts/
 * Player.cs") — so this module deliberately does NOT take a workspacePath
 * param and does NOT try to relativize `status.diffs[].path` (which IS
 * absolute — see `diff-decorator.ts`). It only reads `args.path` for display
 * and uses `status.diffs` purely for the +/- line-count arithmetic. This
 * keeps the function fully pure (3 params, matching the brief) and trivially
 * Bun-testable with no store/Tauri seam at all.
 *
 * +/- counts reuse `generateDiff` from the vendor edit utilities (the same
 * function `DiffBlock` uses to render) so the numbers shown in the collapsed
 * header always agree with the diff a user sees when they expand it.
 *
 * Unrecognized tool names (the `default` branch) return the name unchanged —
 * this is deliberately also the behavior for the Claude/ACP path, whose tool
 * "names" here are already Claude's own human-readable ACP titles (see
 * `claude-agent-service.ts`: `update.title || update.kind || 'tool'`), so
 * falling through to "name as-is" is correct there, not a gap.
 */

import { generateDiff } from './vendor/tools/edit-diff';

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

function argPath(args: Record<string, unknown>): string {
  return typeof args.path === 'string' && args.path.trim() !== '' ? args.path : '(unknown file)';
}

/** Line-arithmetic +/- count over a unified diff, matching what `DiffBlock` renders. */
function countChangedLines(oldText: string, newText: string): { added: number; removed: number } {
  const { diff } = generateDiff(oldText, newText, 'file');
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (
      line.startsWith('+++') ||
      line.startsWith('---') ||
      line.startsWith('@@') ||
      line.startsWith('Index:') ||
      line.startsWith('===')
    ) {
      continue;
    }
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
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
): HumanizedToolCall {
  return { title: `${verb} ${argPath(args)}${diffCountsSuffix(status?.diffs)}` };
}

function humanizeRead(args: Record<string, unknown>): HumanizedToolCall {
  return { title: `Read ${basename(argPath(args))}` };
}

function humanizeList(args: Record<string, unknown>): HumanizedToolCall {
  const path = typeof args.path === 'string' && args.path.trim() !== '' ? args.path : null;
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
  // Bridge/index-backed read tools (unity-tools/read-tools.ts, script-map-tool.ts)
  get_console_errors: 'Checked Unity console',
  get_editor_state: 'Checked Unity editor state',
  get_scene_hierarchy: 'Read Unity scene hierarchy',
  get_game_object: 'Inspected a Unity GameObject',
  find_asset_references: 'Searched asset references',
  get_unity_script_map: 'Mapped Unity scripts',
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
]);

/**
 * Map a raw tool call to a short, human-readable `{ title, subtitle? }` for
 * `ToolCallBlock`'s header. `status` (live/complete tool-call state,
 * `stores/ai.ts`'s `ToolCallStatus`) is optional — a just-started call has
 * none yet, and write/edit titles simply omit the +/- suffix until it arrives.
 */
export function humanizeToolCall(
  name: string,
  args: Record<string, unknown>,
  status?: HumanizeStatus,
): HumanizedToolCall {
  switch (name) {
    case 'write':
      return humanizeWriteOrEdit('Wrote', args, status);
    case 'edit':
      return humanizeWriteOrEdit('Edited', args, status);
    case 'read':
      return humanizeRead(args);
    case 'list':
      return humanizeList(args);
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
