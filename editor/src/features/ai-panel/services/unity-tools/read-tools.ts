// Unity read-only agent tools (F-5.2). Auto-approved tier. Each tool degrades
// gracefully when the bridge is offline (never throws), and `get_console_errors`
// + the static half of `find_asset_references` work fully offline.
//
// DI-seam note (Bun testability): `useUnityStore`, `bridgeRpc` and
// `useUnityIndexStore` all transitively reach `document` — `stores/unity.ts`
// pulls in `unity-bridge`'s React components, and `stores/unity-index.ts`
// pulls in `unity-facts.ts`'s eager store subscription — so this file takes
// NONE of them as a static value import (verified: importing this module
// under Bun crashes with "window is not defined" the moment any of the three
// is imported at module scope). Every runtime access goes through dynamic
// `import()`, either inline (the four tools below that are not unit-tested,
// only required to be Bun-import-safe) or via an explicit `deps` parameter
// for the two that are: `get_console_errors` (`ConsoleToolDeps`) and
// `get_compile_errors` (`CompileErrorsToolDeps`) — mirrors `compile-gate.ts`'s
// `CompileGateDeps` seam exactly. See `read-tools.test.ts`.

import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool } from '../vendor/types';
import type {
  HierarchyNode,
  HierarchyComponent,
  EditorState,
  SceneHierarchy,
  CompileWaitOutcome,
} from '../../../unity-bridge';
import type { RefHit } from '../../../../stores/unity-index';
import type {
  UnityLogEntry,
  UnityLogType,
  CompilationPayload,
  CompilerMessage,
  ConsoleSnapshot,
} from '../../../../types/unity';
import { parseStackTrace } from '../../../../types/unity';
import { txt, cap, NOT_CONNECTED } from './text-result';
import { readScriptGuidFromMeta } from './script-guid';
import { buildCompileHints, type HintLookup } from './compile-hints';
import { describeCompileOutcome } from './compile-outcome-text';

/** Bridge protocol version from which the console snapshot RPC exists. */
const CONSOLE_RPC_MIN_PROTOCOL = 4;

async function isConnected(): Promise<boolean> {
  const { useUnityStore } = await import('../../../../stores/unity');
  return useUnityStore.getState().connected;
}

// ── get_console_errors ───────────────────────────────────────────────────────

const consoleSchema = Type.Object({
  severity: Type.Optional(
    Type.Union([Type.Literal('error'), Type.Literal('warning'), Type.Literal('all')], {
      description: "Minimum severity to include. Default 'error'.",
    }),
  ),
  limit: Type.Optional(Type.Integer({ description: 'Max entries (default 50, max 100).' })),
  page: Type.Optional(Type.Integer({ description: 'Page number, newest first (default 0).' })),
  source: Type.Optional(
    Type.Union([Type.Literal('unity'), Type.Literal('session')], {
      description:
        "'unity' reads Unity's real console including entries from before the IDE connected " +
        "(default when connected); 'session' reads only what streamed to this IDE.",
    }),
  ),
  sinceTurnStart: Type.Optional(
    Type.Boolean({ description: 'Only entries logged since the current turn started.' }),
  ),
  includeStackTrace: Type.Optional(Type.Boolean({ description: 'Include stack traces (default true).' })),
});
type ConsoleParams = Static<typeof consoleSchema>;

/** One log entry in the shape every source (RPC or session ring) is normalized to for rendering. */
export interface ConsoleDisplayEntry {
  seq?: number;
  logType: UnityLogType;
  message: string;
  stackTrace?: string;
  file?: string;
  line?: number;
  historical?: boolean;
}

/** Store/bridge-backed dependencies for `get_console_errors`, injectable for tests. */
export interface ConsoleToolDeps {
  /** Store snapshot: connection, protocol, and the session log ring. */
  unitySnap: () => Promise<{ connected: boolean; bridgeProtocol: number | null; logs: UnityLogEntry[] }>;
  getConsoleSnapshot: (opts: {
    offset?: number;
    limit?: number;
    types?: UnityLogType[];
    includeStackTrace?: boolean;
    order?: 'newest' | 'oldest';
  }) => Promise<ConsoleSnapshot>;
}

export const defaultConsoleToolDeps: ConsoleToolDeps = {
  unitySnap: async () => {
    const { useUnityStore } = await import('../../../../stores/unity');
    const s = useUnityStore.getState();
    return { connected: s.connected, bridgeProtocol: s.bridgeProtocol, logs: s.logs };
  },
  getConsoleSnapshot: async (opts) => {
    const { bridgeRpc } = await import('../../../unity-bridge');
    return bridgeRpc.getConsoleSnapshot(opts);
  },
};

/**
 * Per-send baseline for `sinceTurnStart`, recorded by `agent-service.ts` at
 * the start of every send (next to `resetTurnGovernor()`) from
 * `stores/unity.ts`'s `logSeq`. `UnityLogEntry.seq` is ALWAYS that same
 * client-side counter (assigned on ingest for streamed AND backfilled
 * entries — see the store), so this baseline is comparable across the WHOLE
 * session ring regardless of where an entry originally came from. Unity's own
 * console row numbering (`UnityLogEntry.unityRow`) has no such per-turn
 * concept at all, which is why `sinceTurnStart` always answers from the
 * session ring (see `createGetConsoleErrors`), never from a live RPC read.
 */
let turnStartSeq = 0;
export function markConsoleTurnStart(seq: number): void {
  turnStartSeq = seq;
}

const ERROR_TYPES = new Set<UnityLogType>(['Error', 'Assert', 'Exception', 'CompileError']);
const WARNING_OR_WORSE_TYPES = new Set<UnityLogType>([
  'Warning',
  'CompileWarning',
  'Error',
  'Assert',
  'Exception',
  'CompileError',
]);

function severityTypes(severity: ConsoleParams['severity']): UnityLogType[] | undefined {
  if (severity === 'all') return undefined;
  return [...(severity === 'warning' ? WARNING_OR_WORSE_TYPES : ERROR_TYPES)];
}

function severityAllows(severity: ConsoleParams['severity'], logType: UnityLogType): boolean {
  // No `|| severity == null` branch here: the documented default is 'error'
  // (matches `severityTypes` below), not "show everything" — an absent
  // severity must filter exactly as if 'error' had been passed explicitly.
  if (severity === 'all') return true;
  return (severity === 'warning' ? WARNING_OR_WORSE_TYPES : ERROR_TYPES).has(logType);
}

function countByType(entries: { logType: UnityLogType }[]): { errors: number; warnings: number; logs: number } {
  let errors = 0;
  let warnings = 0;
  let logs = 0;
  for (const e of entries) {
    if (ERROR_TYPES.has(e.logType)) errors++;
    else if (e.logType === 'Warning' || e.logType === 'CompileWarning') warnings++;
    else logs++;
  }
  return { errors, warnings, logs };
}

function firstLine(message: string): string {
  return (message.split('\n')[0] ?? '').trim();
}

function firstProjectFrame(entry: ConsoleDisplayEntry): string {
  if (entry.file) return `${entry.file}:${entry.line ?? 0}`;
  const frame = parseStackTrace(entry.stackTrace ?? '')[0];
  return frame ? `${frame.filePath}:${frame.lineNumber}` : '';
}

function collapseCacheKey(entry: ConsoleDisplayEntry): string {
  return `${entry.logType} ${firstLine(entry.message)} ${firstProjectFrame(entry)}`;
}

/** Collapse consecutive entries with the same `logType + first line + first project frame`. */
export function collapseConsoleEntries(
  entries: ConsoleDisplayEntry[],
): Array<{ entry: ConsoleDisplayEntry; count: number }> {
  const out: Array<{ entry: ConsoleDisplayEntry; count: number }> = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (last && collapseCacheKey(last.entry) === collapseCacheKey(e)) {
      last.count++;
    } else {
      out.push({ entry: e, count: 1 });
    }
  }
  return out;
}

function formatConsoleEntry(entry: ConsoleDisplayEntry, count: number, includeStackTrace: boolean): string {
  const hist = entry.historical ? ' (historical)' : '';
  const times = count > 1 ? ` ×${count}` : '';
  let body = `[${entry.logType}]${hist}${times} ${entry.message}`;
  if (includeStackTrace) {
    // Up to 4 parsed frames, matching what get_console_errors printed before
    // this task — the description promises "and their stack traces", and
    // `includeStackTrace` (default true) must not be accepted and discarded.
    const frames = parseStackTrace(entry.stackTrace ?? '').slice(0, 4);
    if (frames.length > 0) {
      body +=
        '\n' + frames.map((f) => `    at ${f.className}.${f.methodName} (${f.filePath}:${f.lineNumber})`).join('\n');
    }
  }
  return body;
}

interface ConsolePageInfo {
  total: number;
  page: number;
  limit: number;
  truncated: boolean;
}

/** Render the full `get_console_errors` body: header + degraded note + collapsed entries + a paging trailer. */
export function renderConsoleErrors(
  entries: ConsoleDisplayEntry[],
  counts: { errors: number; warnings: number; logs: number },
  // Three sources, three labels. A `hookRing` answer is NOT Unity's console —
  // it is the bridge's own log ring, standing in because Unity's console API
  // is unavailable on that Editor version — and labelling it "Unity console"
  // told the model it had read something it had not (Global Constraint 2).
  sourceLabel: 'Unity console' | 'Unity console (bridge ring)' | 'this session',
  degradedNote: string,
  includeStackTrace: boolean,
  pageInfo: ConsolePageInfo,
): string {
  const header = `Unity console: ${counts.errors} errors, ${counts.warnings} warnings, ${counts.logs} logs (source: ${sourceLabel})`;
  if (entries.length === 0) {
    const totalNote = pageInfo.total > 0 ? ` (${pageInfo.total} total across all pages)` : '';
    return `${header}\n\n${degradedNote}No matching entries${totalNote}.`;
  }
  const body = collapseConsoleEntries(entries)
    .map(({ entry, count }) => formatConsoleEntry(entry, count, includeStackTrace))
    .join('\n\n');
  const more = pageInfo.truncated ? ' — more available, raise page/limit to see them' : '';
  const trailer = `\n\nShowing ${entries.length} of ${pageInfo.total} entries (page ${pageInfo.page})${more}.`;
  return `${header}\n\n${degradedNote}${body}${trailer}`;
}

function toDisplayEntry(e: ConsoleSnapshot['entries'][number]): ConsoleDisplayEntry {
  return {
    seq: e.seq,
    logType: e.logType,
    message: e.message,
    stackTrace: e.stackTrace,
    file: e.file || undefined,
    line: e.line || undefined,
  };
}

function fromSession(entries: UnityLogEntry[]): ConsoleDisplayEntry[] {
  return entries.map((e) => ({
    seq: e.seq,
    logType: e.logType,
    message: e.message,
    stackTrace: e.stackTrace,
    historical: e.historical,
  }));
}

/**
 * Only used when the caller wanted "unity" and could not get it. Distinguishes
 * "we know for a fact the bridge predates protocol 4" from "we don't yet know
 * the protocol" (I2's late-attach race, now recovered in `syncStatus` too, but
 * still possible in the narrow window before that resolves) — the former is a
 * real, actionable fact; the latter must not be reported as one.
 */
function unavailableSessionLabel(snap: { connected: boolean; bridgeProtocol: number | null }): string {
  if (!snap.connected) {
    return "Unity's console history is unavailable: bridge not connected — showing what streamed to this IDE this session.\n\n";
  }
  if (snap.bridgeProtocol != null && snap.bridgeProtocol < CONSOLE_RPC_MIN_PROTOCOL) {
    return "Unity's console history is unavailable: the installed bridge package predates protocol 4 — update it\n\n";
  }
  return "Unity's console history is unavailable: the bridge's protocol version isn't known yet — showing what streamed to this IDE this session.\n\n";
}

/**
 * `getConsoleSnapshot` is a BLOCKING RPC that fails outright (worker timeout)
 * when Unity's main thread is parked in the background — the normal state
 * while the user is looking at this IDE, not a sign the bridge predates
 * protocol 4. Conflating the two used to blame the package version for what
 * is actually a backgrounded Unity window.
 */
const RPC_REQUEST_FAILED_LABEL =
  "Unity's console history is unavailable: the request to Unity failed or timed out — Unity may be in the background. Showing what streamed to this IDE this session.\n\n";

/**
 * Unity's real console has no notion of "since this turn" — only the session
 * ring's client-assigned `seq` is comparable across turns (see
 * `markConsoleTurnStart`). So `sinceTurnStart` always reads the session ring,
 * even when the caller asked for `source:"unity"`; this explains why when it
 * did.
 */
const SINCE_TURN_START_NOTE =
  "since-turn-start uses this session's stream — Unity's real console row numbering has no comparable per-turn baseline.\n\n";

function renderSessionConsole(
  snap: { logs: UnityLogEntry[] },
  params: ConsoleParams,
  limit: number,
  page: number,
  includeStackTrace: boolean,
  degradedNote: string,
): string {
  const { severity, sinceTurnStart = false } = params;
  let scoped = snap.logs;
  if (sinceTurnStart) scoped = scoped.filter((e) => (e.seq ?? 0) > turnStartSeq);

  const counts = countByType(scoped);
  const filtered = scoped.filter((e) => severityAllows(severity, e.logType));
  const newestFirst = [...filtered].reverse();
  const start = page * limit;
  const paged = newestFirst.slice(start, start + limit);

  return renderConsoleErrors(fromSession(paged), counts, 'this session', degradedNote, includeStackTrace, {
    total: filtered.length,
    page,
    limit,
    truncated: start + paged.length < filtered.length,
  });
}

export function createGetConsoleErrors(deps: ConsoleToolDeps = defaultConsoleToolDeps): AgentTool {
  return {
    name: 'get_console_errors',
    label: 'get console errors',
    description:
      "Get Unity console entries. Reads Unity's REAL console (including entries from before this IDE " +
      'connected) when the bridge supports it; otherwise falls back to what streamed to this IDE this ' +
      'session, and says so. Use this to inspect runtime errors/exceptions, compiler diagnostics, and ' +
      'their stack traces.',
    parameters: consoleSchema,
    async execute(_id, rawParams) {
      const params = rawParams as ConsoleParams;
      const limit = Math.min(Math.max(1, params.limit ?? 50), 100);
      const page = Math.max(0, params.page ?? 0);
      const includeStackTrace = params.includeStackTrace ?? true;
      // "unity" is the default UNLESS the caller explicitly asked for
      // "session" — even while disconnected, so a fallback still gets labeled
      // as one rather than silently answering as if session-only were the ask.
      const wantedUnity = params.source !== 'session';

      const snap = await deps.unitySnap();

      // sinceTurnStart is only meaningful against the session ring's
      // client-side seq (see markConsoleTurnStart's docs) — always answered
      // from there, regardless of `source`.
      if (params.sinceTurnStart) {
        const note = wantedUnity ? SINCE_TURN_START_NOTE : '';
        return txt(cap(renderSessionConsole(snap, params, limit, page, includeStackTrace, note)));
      }

      const canUseRpc = snap.connected && (snap.bridgeProtocol ?? 0) >= CONSOLE_RPC_MIN_PROTOCOL;
      if (!wantedUnity || !canUseRpc) {
        const note = wantedUnity ? unavailableSessionLabel(snap) : '';
        return txt(cap(renderSessionConsole(snap, params, limit, page, includeStackTrace, note)));
      }

      try {
        const snapshot = await deps.getConsoleSnapshot({
          offset: page * limit,
          limit,
          types: severityTypes(params.severity),
          includeStackTrace,
          order: 'newest',
        });
        const entries = snapshot.entries.map(toDisplayEntry);
        const fromHookRing = snapshot.source === 'hookRing';
        const degradedNote = fromHookRing
          ? "Unity's own console API is unavailable on this Editor version — showing the bridge's own " +
            'log history instead of Unity\'s real console.\n\n'
          : '';
        return txt(
          cap(
            renderConsoleErrors(
              entries,
              snapshot.counts,
              fromHookRing ? 'Unity console (bridge ring)' : 'Unity console',
              degradedNote,
              includeStackTrace,
              {
                total: snapshot.total,
                page,
                limit,
                truncated: snapshot.truncated,
              },
            ),
          ),
        );
      } catch {
        // The RPC round-trip itself failed (bridge dropped mid-call, Unity
        // parked in the background, etc.) — degrade to the session ring with
        // a label distinct from "predates protocol 4" (I1): we know the
        // protocol supports this RPC, the CALL just didn't land.
        return txt(cap(renderSessionConsole(snap, params, limit, page, includeStackTrace, RPC_REQUEST_FAILED_LABEL)));
      }
    },
  };
}

// ── get_compile_errors ───────────────────────────────────────────────────────

// Mirrors `unity-bridge`'s `compile-wait-core.ts` `OVERALL_TIMEOUT_MS` (90s)
// plus a 5s margin for the RPC round-trip. Not imported directly: that value
// is needed synchronously at tool-registration time, and the `unity-bridge`
// barrel also exports React components that are not Bun-importable.
const COMPILE_ERRORS_TIMEOUT_MS = 90_000 + 5_000;
const MAX_COMPILE_ERROR_LINES = 30;
/** Hint lookups are best-effort garnish — never let them stall the result (mirrors compile-gate.ts). */
const HINTS_BUDGET_MS = 8_000;

const compileErrorsSchema = Type.Object({
  recompile: Type.Optional(
    Type.Boolean({
      description:
        'Ask Unity to import and compile now, and wait for the report (up to 90s). Default false: ' +
        'report the last compile Unity announced this session.',
    }),
  ),
});
type CompileErrorsParams = Static<typeof compileErrorsSchema>;

/** Store/bridge-backed dependencies for `get_compile_errors`, injectable for tests. */
export interface CompileErrorsToolDeps {
  lastCompilation: () => Promise<CompilationPayload | null>;
  recompile: (opts: { signal?: AbortSignal }) => Promise<CompileWaitOutcome>;
}

export const defaultCompileErrorsToolDeps: CompileErrorsToolDeps = {
  lastCompilation: async () => {
    const { useUnityStore } = await import('../../../../stores/unity');
    return useUnityStore.getState().lastCompilation;
  },
  recompile: async (opts) => {
    const { triggerRecompileAndWait } = await import('../../../unity-bridge');
    return triggerRecompileAndWait(opts);
  },
};

function raceWithFallback<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** Render a `receivedAt` timestamp as "N minute(s)/hour(s)/second(s) ago". */
export function formatCompileAge(receivedAt: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - receivedAt) / 1000));
  if (seconds < 60) return seconds <= 1 ? 'just now' : `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}

/** Render a compile report's errors: `N compiler error(s)` then up to 30 `file:line: message` lines. */
export async function renderCompileReport(
  messages: CompilerMessage[],
  client: HintLookup,
  hintsBudgetMs = HINTS_BUDGET_MS,
): Promise<string> {
  const errors = messages.filter((m) => m.type === 'Error');
  if (errors.length === 0) return describeCompileOutcome({ status: 'report', report: { started: false, messages } });

  const shown = errors.slice(0, MAX_COMPILE_ERROR_LINES);
  const lines = shown.map((m) => `  ${m.file}:${m.line}: ${m.message}`);
  let text = `${errors.length} compiler error(s):\n${lines.join('\n')}`;
  if (errors.length > shown.length) {
    text += `\n(+${errors.length - shown.length} more compiler error(s) not shown)`;
  }
  text += await raceWithFallback(buildCompileHints(shown, client), hintsBudgetMs, '');
  return text;
}

export function createGetCompileErrors(client: HintLookup, deps: CompileErrorsToolDeps = defaultCompileErrorsToolDeps): AgentTool {
  return {
    name: 'get_compile_errors',
    label: 'get compile errors',
    description:
      "Get Unity's compiler diagnostics for this project. By default reports the LAST compile Unity " +
      'announced this session (instant, no engine round-trip); with recompile:true, asks Unity to ' +
      'import and compile now and waits for the report (up to 90s).',
    parameters: compileErrorsSchema,
    timeoutMs: COMPILE_ERRORS_TIMEOUT_MS,
    async execute(_id, rawParams, signal) {
      const { recompile = false } = rawParams as CompileErrorsParams;

      if (!recompile) {
        const last = await deps.lastCompilation();
        if (!last) {
          return txt(
            'No compile report this session. Pass recompile:true to ask Unity to compile now, ' +
              'or wait for a script save to trigger one.',
          );
        }
        const errorCount = (last.messages ?? []).filter((m) => m.type === 'Error').length;
        const age = last.receivedAt != null ? formatCompileAge(last.receivedAt) : 'unknown time';
        const header = `Last compile report: ${age} (${errorCount} error${errorCount === 1 ? '' : 's'})\n\n`;
        return txt(cap(header + (await renderCompileReport(last.messages ?? [], client))));
      }

      const outcome = await deps.recompile({ signal });
      if (outcome.status === 'report') {
        return txt(cap(await renderCompileReport(outcome.report.messages ?? [], client)));
      }
      const text = describeCompileOutcome(outcome);
      return txt(text || 'Compile status unknown.');
    },
  };
}

// ── get_editor_state ─────────────────────────────────────────────────────────

async function fetchEditorState(): Promise<EditorState> {
  const { bridgeRpc } = await import('../../../unity-bridge');
  return bridgeRpc.getEditorState();
}

function createGetEditorState(): AgentTool {
  return {
    name: 'get_editor_state',
    label: 'get editor state',
    description:
      'Get the live Unity Editor state: play/pause/compile status, Unity version, and the list of open scenes. Requires a connected bridge.',
    parameters: Type.Object({}),
    async execute() {
      if (!(await isConnected())) return txt(NOT_CONNECTED);
      try {
        const s = await fetchEditorState();
        return txt(
          `Unity ${s.unityVersion} — ${s.isPlaying ? (s.isPaused ? 'paused' : 'playing') : 'edit mode'}` +
            `${s.isCompiling ? ' (compiling)' : ''}\nOpen scenes: ${s.activeScenes.join(', ') || '(none)'}`,
        );
      } catch (e) {
        return txt(`Could not read editor state: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

// ── get_scene_hierarchy ──────────────────────────────────────────────────────

function formatNode(n: HierarchyNode, depth: number, maxDepth: number, out: string[]): void {
  const indent = '  '.repeat(depth);
  const comps = n.components.map((c) => c.type).join(', ');
  out.push(`${indent}${n.name}${n.active ? '' : ' (inactive)'} [${comps || 'no components'}]`);
  if (depth < maxDepth) {
    for (const c of n.children) formatNode(c, depth + 1, maxDepth, out);
  } else if (n.children.length > 0) {
    out.push(`${indent}  …${n.children.length} more (depth limit)`);
  }
}

const hierarchySchema = Type.Object({
  maxDepth: Type.Optional(Type.Integer({ description: 'Tree depth to render (default 6).' })),
});

async function fetchSceneHierarchy(): Promise<SceneHierarchy> {
  const { bridgeRpc } = await import('../../../unity-bridge');
  return bridgeRpc.getSceneHierarchy();
}

function createGetSceneHierarchy(): AgentTool {
  return {
    name: 'get_scene_hierarchy',
    label: 'get scene hierarchy',
    description:
      'Get the live GameObject hierarchy of the open scene(s) in Unity, with each object\'s component types. Requires a connected bridge.',
    parameters: hierarchySchema,
    async execute(_id, params) {
      if (!(await isConnected())) return txt(NOT_CONNECTED);
      const { maxDepth = 6 } = params as Static<typeof hierarchySchema>;
      try {
        const h = await fetchSceneHierarchy();
        const out: string[] = [];
        for (const scene of h.scenes) {
          out.push(`# Scene: ${scene.name}`);
          for (const root of scene.roots) formatNode(root, 0, maxDepth, out);
        }
        if (h.truncated) out.push('…(hierarchy truncated by the bridge — large scene)');
        return txt(cap(out.join('\n') || '(no open scenes)'));
      } catch (e) {
        return txt(`Could not read hierarchy: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

// ── get_game_object ──────────────────────────────────────────────────────────

const gameObjectSchema = Type.Object({
  instanceId: Type.Optional(Type.Integer({ description: 'Instance id (preferred).' })),
  path: Type.Optional(Type.String({ description: 'Hierarchy path "Parent/Child".' })),
});

async function fetchGameObject(
  t: { instanceId?: number; path?: string },
): Promise<HierarchyNode & { components: HierarchyComponent[] }> {
  const { bridgeRpc } = await import('../../../unity-bridge');
  return bridgeRpc.getGameObject(t);
}

function createGetGameObject(): AgentTool {
  return {
    name: 'get_game_object',
    label: 'get game object',
    description:
      'Get a live GameObject\'s components and their serialized property values from Unity, by instanceId or hierarchy path. Use after get_scene_hierarchy to inspect a specific object (e.g. to check whether a serialized field is assigned). Requires a connected bridge.',
    parameters: gameObjectSchema,
    async execute(_id, params) {
      if (!(await isConnected())) return txt(NOT_CONNECTED);
      const t = params as Static<typeof gameObjectSchema>;
      if (t.instanceId == null && !t.path) return txt('Provide instanceId or path.');
      try {
        const go = await fetchGameObject(t);
        return txt(cap(JSON.stringify(go, null, 1)));
      } catch (e) {
        return txt(`Could not read GameObject: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

// ── find_asset_references ────────────────────────────────────────────────────

const refsSchema = Type.Object({
  scriptPath: Type.Optional(Type.String({ description: 'Absolute path to a .cs script.' })),
  guid: Type.Optional(Type.String({ description: 'Asset GUID (alternative to scriptPath).' })),
});

async function findReferencesInIndex(guid: string): Promise<RefHit[]> {
  const { useUnityIndexStore } = await import('../../../../stores/unity-index');
  return useUnityIndexStore.getState().findReferences(guid);
}

async function fetchLiveReferences(guid: string): Promise<{ scene: string; path: string; instanceId: number }[]> {
  const { bridgeRpc } = await import('../../../unity-bridge');
  const live = await bridgeRpc.findReferencesToScript(guid);
  return live.gameObjects;
}

function createFindAssetReferences(): AgentTool {
  return {
    name: 'find_asset_references',
    label: 'find asset references',
    description:
      'Find which scenes/prefabs/assets reference a script or asset (by GUID). The static half uses the offline GUID index (works without Unity); when the bridge is connected it also lists the live GameObject instances using the script.',
    parameters: refsSchema,
    async execute(_id, params) {
      const { scriptPath, guid: guidIn } = params as Static<typeof refsSchema>;
      const guid = guidIn ?? (scriptPath ? await readScriptGuidFromMeta(scriptPath) : null);
      if (!guid) return txt('Could not resolve a GUID (pass guid, or a scriptPath whose .meta exists).');

      const out: string[] = [];
      const hits = await findReferencesInIndex(guid);
      if (hits.length === 0) out.push(`No assets reference ${guid} (per the offline index).`);
      else {
        out.push(`Referenced in ${hits.length} asset(s):`);
        for (const h of hits.slice(0, 50)) out.push(`  ${h.path} (${h.count}×)`);
      }

      if (await isConnected()) {
        try {
          const gameObjects = await fetchLiveReferences(guid);
          if (gameObjects.length > 0) {
            out.push(`\nLive GameObjects using this script (${gameObjects.length}):`);
            for (const g of gameObjects.slice(0, 50)) out.push(`  ${g.scene}: ${g.path}`);
          }
        } catch {
          out.push('\n(live scene instances unavailable — bridge error)');
        }
      } else {
        out.push('\n(live scene instances unavailable — Unity not connected)');
      }
      return txt(cap(out.join('\n')));
    },
  };
}

/** Bridge/index-backed Unity read tools (auto-approved tier). */
export function createUnityBridgeReadTools(client: HintLookup): AgentTool[] {
  return [
    createGetConsoleErrors(),
    createGetCompileErrors(client),
    createGetEditorState(),
    createGetSceneHierarchy(),
    createGetGameObject(),
    createFindAssetReferences(),
  ];
}
