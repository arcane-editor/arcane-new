import { create } from 'zustand';
import { applySetVariable, type VariableNode } from './debug-variables';
// Re-exported so existing importers of `stores/debug` keep working.
export { applySetVariable };
export type { VariableNode };
import { invoke } from '@tauri-apps/api/core';
import { dapClient } from '../features/debugger';
import { useWorkspaceStore } from './workspace';
import { useNotificationsStore, notify } from './notifications';
import { useUnityStore } from './unity';
import { bridgeRpc } from '../features/unity-bridge';

export type DebugStatus = 'inactive' | 'attaching' | 'running' | 'paused' | 'terminated';

export interface Breakpoint {
  line: number;
  condition?: string;
  hitCondition?: string;
  /**
   * A logpoint: print this and keep going instead of stopping. `{expression}`
   * holes are evaluated in the frame — a print statement you did not have to
   * recompile for.
   */
  logMessage?: string;
  verified?: boolean;
}

/** One line in the debug console. */
export interface ConsoleLine {
  /** DAP output category: `console`, `stdout`, `stderr`, `important`. */
  category: string;
  text: string;
}

/**
 * How many console lines to keep.
 *
 * A logpoint inside `Update()` produces sixty lines a second, so this is a
 * bounded buffer rather than a growing log.
 */
const MAX_CONSOLE_LINES = 5000;

export interface StackFrame {
  id: number;
  name: string;
  path?: string;
  line: number;
  column: number;
}


export interface Scope {
  name: string;
  variablesReference: number;
}

/**
 * The adapter's `initialize` response body. It was discarded, so nothing could
 * feature-detect: `supportsSetVariable`, `exceptionBreakpointFilters` and
 * `supportsLogPoints` all live here and every optional debugger feature has to
 * gate on them or risk sending a request the adapter rejects mid-session.
 */
export interface DapCapabilities {
  supportsSetVariable?: boolean;
  supportsSetExpression?: boolean;
  supportsLogPoints?: boolean;
  exceptionBreakpointFilters?: Array<{ filter: string; label: string; default?: boolean }>;
}

/**
 * An attachable debugger endpoint, as reported by the `debug_targets` command.
 *
 * For a Unity editor the port is `56000 + (pid % 1000)`, read from
 * `Library/EditorInstance.json` — the same signal Unity's own tooling uses.
 */
export interface DebugTarget {
  id: string;
  kind: 'unityEditor' | 'unityPlayer';
  label: string;
  host: string;
  port: number;
  pid?: number;
}

interface DebugState {
  capabilities: DapCapabilities;
  status: DebugStatus;
  /** Attach targets discovered for this project. */
  targets: DebugTarget[];
  /** Which target the user picked, when there is more than one. */
  selectedTargetId: string | null;
  /** True while the slow player/Android scan is running. */
  scanning: boolean;
  /** Why there is nothing to attach to, if there isn't. */
  unavailableReason: string | null;
  /** Breakpoints by absolute file path. */
  breakpoints: Map<string, Breakpoint[]>;
  threads: Array<{ id: number; name: string }>;
  currentThreadId: number | null;
  frames: StackFrame[];
  currentFrameId: number | null;
  scopes: Scope[];
  /** Lazily-loaded children keyed by variablesReference. */
  variables: Map<number, VariableNode[]>;
  watches: string[];
  watchResults: Map<string, string>;
  /** Debug console output: logpoints, condition failures, adapter notices. */
  consoleLines: ConsoleLine[];
  clearConsole: () => void;

  loadTargets: () => Promise<DebugTarget[]>;
  /** The slow scan: network players and attached Android devices. */
  scanTargets: () => Promise<DebugTarget[]>;
  selectTarget: (id: string | null) => void;
  toggleBreakpoint: (file: string, line: number) => void;
  setBreakpointCondition: (
    file: string,
    line: number,
    condition?: string,
    hitCondition?: string,
    logMessage?: string,
  ) => void;
  breakpointsFor: (file: string) => Breakpoint[];

  attach: (play: boolean) => Promise<void>;
  resume: () => Promise<void>;
  pause: () => Promise<void>;
  stepOver: () => Promise<void>;
  stepIn: () => Promise<void>;
  stepOut: () => Promise<void>;
  stop: () => Promise<void>;
  selectFrame: (frameId: number) => Promise<void>;
  loadChildren: (variablesReference: number) => Promise<void>;
  /** Write a new value into a variable and refresh the rows that showed it. */
  setVariable: (containerRef: number, name: string, value: string) => Promise<void>;
  /** Run until `line` without leaving a breakpoint behind. */
  runToCursor: (file: string, line: number) => Promise<void>;
  /** Move the execution pointer to `line` inside the current method. */
  setNextStatement: (file: string, line: number) => Promise<void>;
  addWatch: (expr: string) => void;
  removeWatch: (expr: string) => void;
}

function bpStorageKey(workspace: string): string {
  return `unityide.debug.breakpoints.${workspace}`;
}

function loadBreakpoints(workspace: string): Map<string, Breakpoint[]> {
  try {
    const raw = localStorage.getItem(bpStorageKey(workspace));
    if (!raw) return new Map();
    return new Map(Object.entries(JSON.parse(raw)));
  } catch {
    return new Map();
  }
}

function persistBreakpoints(workspace: string, bps: Map<string, Breakpoint[]>): void {
  try {
    localStorage.setItem(bpStorageKey(workspace), JSON.stringify(Object.fromEntries(bps)));
  } catch {
    /* quota / unavailable — non-fatal */
  }
}

let handlersBound = false;

export const useDebugStore = create<DebugState>((set, get) => ({
  capabilities: {},
  status: 'inactive',
  targets: [],
  selectedTargetId: null,
  scanning: false,
  unavailableReason: null,
  // Hydrated post-init (see the queueMicrotask below). Reading useWorkspaceStore
  // here would run during this store's module-eval and TDZ-crash the boot when
  // debug.ts is pulled into an early import cycle (editor → debugger gutter /
  // unity-test-runner → useDebugStore, before workspace.ts finishes init).
  breakpoints: new Map(),
  threads: [],
  currentThreadId: null,
  frames: [],
  currentFrameId: null,
  scopes: [],
  variables: new Map(),
  watches: [],
  watchResults: new Map(),
  consoleLines: [],

  clearConsole: () => set({ consoleLines: [] }),

  loadTargets: async () => {
    const workspacePath = useWorkspaceStore.getState().workspacePath;
    if (!workspacePath) {
      set({ targets: [], unavailableReason: 'No project is open.' });
      return [];
    }
    try {
      const targets = await invoke<DebugTarget[]>('debug_targets', { workspacePath });
      set({
        targets,
        // Nothing to install any more — the debugger is built in. The only
        // reason it can be unavailable is that Unity is not running.
        unavailableReason: targets.length
          ? null
          : 'No running Unity editor found for this project. Open the project in Unity, then attach.',
      });
      return targets;
    } catch (err) {
      set({ targets: [], unavailableReason: `Could not look for a Unity editor: ${String(err)}` });
      return [];
    }
  },

  scanTargets: async () => {
    const workspacePath = useWorkspaceStore.getState().workspacePath;
    if (!workspacePath) return [];
    set({ scanning: true });
    try {
      const targets = await invoke<DebugTarget[]>('debug_scan_targets', { workspacePath });
      set({
        targets,
        unavailableReason: targets.length
          ? null
          : 'Nothing found to attach to. Open the project in Unity, or run a development build with script debugging enabled.',
      });
      return targets;
    } catch (err) {
      set({ unavailableReason: `Could not scan for targets: ${String(err)}` });
      return get().targets;
    } finally {
      set({ scanning: false });
    }
  },

  selectTarget: (id) => set({ selectedTargetId: id }),

  breakpointsFor: (file) => get().breakpoints.get(file) ?? [],

  toggleBreakpoint: (file, line) => {
    const map = new Map(get().breakpoints);
    const list = [...(map.get(file) ?? [])];
    const idx = list.findIndex((b) => b.line === line);
    if (idx >= 0) list.splice(idx, 1);
    else list.push({ line });
    if (list.length) map.set(file, list);
    else map.delete(file);
    set({ breakpoints: map });
    persistBreakpoints(useWorkspaceStore.getState().workspacePath ?? '', map);
    void syncBreakpointsForFile(file, list);
  },

  setBreakpointCondition: (file, line, condition, hitCondition, logMessage) => {
    const map = new Map(get().breakpoints);
    const list = [...(map.get(file) ?? [])];
    const bp = list.find((b) => b.line === line);
    if (bp) {
      bp.condition = condition;
      bp.hitCondition = hitCondition;
      bp.logMessage = logMessage;
      map.set(file, list);
      set({ breakpoints: map });
      persistBreakpoints(useWorkspaceStore.getState().workspacePath ?? '', map);
      void syncBreakpointsForFile(file, list);
    }
  },

  attach: async (play) => {
    const notify = useNotificationsStore.getState().addNotification;
    const workspacePath = useWorkspaceStore.getState().workspacePath;
    if (!workspacePath) {
      notify({ type: 'warning', message: 'Open a Unity project before attaching.' });
      return;
    }

    // Resolve the debugger endpoint.
    //
    // Discovery leads, because it is the only source that knows about players
    // and Android devices — and because an explicit choice in the picker must
    // not be overridden by whatever the bridge happens to report. The bridge is
    // the fallback for setups discovery cannot see. It used to be the only
    // source *and* mandatory, so attach aborted outright whenever the in-editor
    // package was not connected, leaving a perfectly debuggable editor
    // unreachable.
    let host = '127.0.0.1';
    let port = 0;

    const known = get().targets.length ? get().targets : await get().loadTargets();
    const chosen = known.find((t) => t.id === get().selectedTargetId) ?? known[0];

    if (chosen) {
      host = chosen.host;
      port = chosen.port;
    } else {
      try {
        const ep = await bridgeRpc.getDebuggerEndpoint();
        host = ep.host;
        port = ep.port;
      } catch {
        notify({
          type: 'warning',
          message:
            get().unavailableReason ?? 'No running Unity editor found for this project.',
          persistent: true,
        });
        return;
      }
    }

    set({ status: 'attaching' });
    try {
      bindDapHandlers(set, get);
      await dapClient.start(workspacePath);
      // The response body is the adapter's capability set. It used to be
      // dropped on the floor, so nothing could tell whether setVariable,
      // logpoints or exception filters were available.
      const caps = await dapClient.request<DapCapabilities | undefined>('initialize', {
        clientID: 'hosted',
        adapterID: 'mono',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
        supportsVariableType: true,
      });
      set({ capabilities: caps ?? {} });
      // attach kicks the session; the 'initialized' event handler then sends
      // breakpoints + configurationDone.
      await dapClient.request('attach', { host, port });
      if (play) {
        await useUnityStore.getState().sendPlay();
      }
      set({ status: 'running' });
      void warnIfEditorIsOptimized();
    } catch (err) {
      notify({ type: 'error', message: `Attach failed: ${String(err)}` });
      set({ status: 'inactive' });
      await dapClient.stop().catch(() => {});
    }
  },

  resume: async () => {
    const tid = get().currentThreadId;
    await dapClient.request('continue', { threadId: tid ?? 0 }).catch(() => {});
    set({ status: 'running', frames: [], scopes: [], variables: new Map() });
  },
  pause: async () => {
    const tid = get().currentThreadId ?? get().threads[0]?.id ?? 0;
    await dapClient.request('pause', { threadId: tid }).catch(() => {});
  },
  stepOver: async () => {
    await dapClient.request('next', { threadId: get().currentThreadId ?? 0 }).catch(() => {});
  },
  stepIn: async () => {
    await dapClient.request('stepIn', { threadId: get().currentThreadId ?? 0 }).catch(() => {});
  },
  stepOut: async () => {
    await dapClient.request('stepOut', { threadId: get().currentThreadId ?? 0 }).catch(() => {});
  },
  stop: async () => {
    await dapClient.stop().catch(() => {});
    set({ status: 'terminated', frames: [], scopes: [], variables: new Map(), threads: [] });
  },

  selectFrame: async (frameId) => {
    set({ currentFrameId: frameId, scopes: [], variables: new Map() });
    try {
      const res = await dapClient.request<{ scopes: Array<{ name: string; variablesReference: number }> }>(
        'scopes',
        { frameId },
      );
      const scopes = res.scopes ?? [];
      set({ scopes });
      // Eagerly load the first scope (Locals).
      if (scopes[0]) await get().loadChildren(scopes[0].variablesReference);
      // Refresh watches against the selected frame.
      await refreshWatches(frameId, set, get);
    } catch {
      /* frame went away */
    }
  },

  loadChildren: async (variablesReference) => {
    if (variablesReference <= 0) return;
    try {
      const res = await dapClient.request<{ variables: VariableNode[] }>('variables', {
        variablesReference,
      });
      const map = new Map(get().variables);
      map.set(variablesReference, res.variables ?? []);
      set({ variables: map });
    } catch {
      /* ignore */
    }
  },

  setVariable: async (containerRef, name, value) => {
    if (containerRef <= 0) return;
    try {
      const res = await dapClient.request<{
        value: string;
        type?: string;
        variablesReference?: number;
      }>('setVariable', { variablesReference: containerRef, name, value });

      set({ variables: applySetVariable(get().variables, containerRef, name, res) });

      // A watch expression may read the field just changed, so re-evaluate.
      const fid = get().currentFrameId;
      if (fid != null) void refreshWatches(fid, set, get);
    } catch (err) {
      notify.error(`Could not set ${name}: ${String(err)}`);
    }
  },

  runToCursor: async (file, line) => {
    if (get().status !== 'paused') return;
    try {
      await dapClient.request('runToCursor', { source: { path: file }, line });
    } catch (err) {
      notify.error(`Run to cursor failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },

  setNextStatement: async (file, line) => {
    if (get().status !== 'paused') return;
    const threadId = get().currentThreadId ?? undefined;
    try {
      // Ask what is reachable first: the runtime can only move the pointer
      // inside the method already executing, so a line elsewhere has no target
      // and saying so beats attempting a jump that will be refused.
      const targets = await dapClient.request<{
        targets: Array<{ id: number; label: string }>;
      }>('gotoTargets', { source: { path: file }, line });
      const target = targets.targets?.[0];
      if (!target) {
        notify.warning('Execution can only be moved within the current method.');
        return;
      }
      await dapClient.request('goto', { threadId, targetId: target.id });
    } catch (err) {
      notify.error(
        `Could not move execution: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },

  addWatch: (expr) => {
    if (!expr.trim() || get().watches.includes(expr)) return;
    set({ watches: [...get().watches, expr] });
    const fid = get().currentFrameId;
    if (fid != null) void refreshWatches(fid, set, get);
  },
  removeWatch: (expr) => {
    set({ watches: get().watches.filter((w) => w !== expr) });
    const map = new Map(get().watchResults);
    map.delete(expr);
    set({ watchResults: map });
  },
}));

// Restore persisted breakpoints for the active workspace once modules finish
// evaluating — deferred so debug.ts's module-eval never reads useWorkspaceStore
// while workspace.ts is still initializing (the boot TDZ). main.tsx awaits
// hydratePersistence() before bootEditor, so workspacePath is already set here.
queueMicrotask(() => {
  const wp = useWorkspaceStore.getState().workspacePath;
  if (wp) {
    const bps = loadBreakpoints(wp);
    if (bps.size > 0) useDebugStore.setState({ breakpoints: bps });
  }
});

/** Push the breakpoints for one file to the adapter (if a session is live). */
async function syncBreakpointsForFile(file: string, list: Breakpoint[]): Promise<void> {
  if (!dapClient.isRunning()) return;
  try {
    await dapClient.request('setBreakpoints', {
      source: { path: file, name: file.split('/').pop() },
      breakpoints: list.map((b) => ({
        line: b.line,
        condition: b.condition,
        hitCondition: b.hitCondition,
        logMessage: b.logMessage,
      })),
    });
  } catch (err) {
    // A breakpoint the adapter never received is indistinguishable, in the
    // gutter, from one it accepted — the user sets it, sees the red dot, runs,
    // and it simply never hits. Say so rather than reporting success.
    notify.error(
      `Could not set breakpoints in ${file.split('/').pop() ?? file}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

async function refreshWatches(
  frameId: number,
  set: (partial: Partial<DebugState>) => void,
  get: () => DebugState,
): Promise<void> {
  const results = new Map(get().watchResults);
  for (const expr of get().watches) {
    try {
      const res = await dapClient.request<{ result: string }>('evaluate', {
        expression: expr,
        frameId,
        context: 'watch',
      });
      results.set(expr, res.result);
    } catch {
      results.set(expr, '<error>');
    }
  }
  set({ watchResults: results });
}

/** Bind DAP adapter events to store updates. Idempotent. */
/**
 * Tell the user when the Editor is compiled for speed rather than for debugging.
 *
 * Unity 2020.1+ starts in Release, where the JIT discards locals and folds
 * statements: breakpoints land on the wrong line and variables read as
 * unavailable. Nothing in Unity surfaces this, so the debugger looks broken
 * while being perfectly attached — it is the most common false "the debugger
 * doesn't work" report there is.
 *
 * Offered, never done automatically: switching triggers a domain reload, which
 * throws away Play Mode state. Silent for Editors that predate the setting, and
 * silent when the bridge is not connected — attaching does not depend on it.
 */
async function warnIfEditorIsOptimized(): Promise<void> {
  let state: { supported: boolean; mode: 'debug' | 'release' };
  try {
    state = await bridgeRpc.getCodeOptimization();
  } catch {
    return;
  }
  if (!state.supported || state.mode === 'debug') return;

  useNotificationsStore.getState().addNotification({
    type: 'warning',
    persistent: true,
    message:
      'Unity is running in Release code optimization. Breakpoints and variables will be unreliable until you switch to Debug (this reloads the domain).',
    actions: [
      {
        label: 'Switch to Debug',
        run: () => {
          void bridgeRpc.setCodeOptimization('debug').catch(() => {});
        },
      },
    ],
  });
}

/**
 * Compare two paths the way the debugger has to.
 *
 * The runtime reports the path its compiler recorded — native separators, and
 * on Windows any casing — while the editor keys breakpoints by the path Monaco
 * gave it. Comparing them literally makes every binding notification miss.
 */
function samePath(a: string, b: string): boolean {
  const normalize = (p: string) => {
    const forward = p.replace(/\\/g, '/');
    return isWindowsPath(forward) ? forward.toLowerCase() : forward;
  };
  return normalize(a) === normalize(b);
}

function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:\//.test(p);
}

function bindDapHandlers(
  set: (partial: Partial<DebugState>) => void,
  get: () => DebugState,
): void {
  if (handlersBound) return;
  handlersBound = true;

  // On 'initialized', push breakpoints + exception filters, then configurationDone.
  dapClient.on('initialized', () => {
    void (async () => {
      for (const [file, list] of get().breakpoints) {
        await syncBreakpointsForFile(file, list);
      }
      // Use the filters the session actually offers rather than a hardcoded
      // name. The old code always sent `user-unhandled`, which meant the
      // exception-filter capability was reported and then ignored.
      const offered = get().capabilities.exceptionBreakpointFilters ?? [];
      const enabled = offered.filter((f) => f.default).map((f) => f.filter);
      await dapClient
        .request('setExceptionBreakpoints', {
          filters: enabled.length ? enabled : ['uncaught'],
        })
        .catch(() => {});
      await dapClient.request('configurationDone').catch(() => {});
    })();
  });

  dapClient.on('stopped', (body) => {
    const b = body as { threadId?: number };
    const threadId = b.threadId ?? get().currentThreadId ?? 0;
    set({ status: 'paused', currentThreadId: threadId });
    void (async () => {
      try {
        const threadsRes = await dapClient.request<{ threads: Array<{ id: number; name: string }> }>('threads');
        const stackRes = await dapClient.request<{
          stackFrames: Array<{ id: number; name: string; line: number; column: number; source?: { path?: string } }>;
        }>('stackTrace', { threadId, startFrame: 0, levels: 50 });
        const frames: StackFrame[] = (stackRes.stackFrames ?? []).map((f) => ({
          id: f.id,
          name: f.name,
          path: f.source?.path,
          line: f.line,
          column: f.column,
        }));
        set({ threads: threadsRes.threads ?? [], frames });
        if (frames[0]) await get().selectFrame(frames[0].id);
      } catch {
        /* ignore */
      }
    })();
  });

  dapClient.on('continued', () => {
    set({ status: 'running', frames: [], scopes: [], variables: new Map() });
  });

  // Logpoint output, condition failures and adapter notices. Nothing consumed
  // these before, so a logpoint printed into the void.
  dapClient.on('output', (body) => {
    const b = body as { category?: string; output?: string };
    if (!b.output) return;
    const lines = get().consoleLines.concat({
      category: b.category ?? 'console',
      text: b.output,
    });
    // Bounded: a logpoint in Update() writes sixty lines a second.
    set({
      consoleLines:
        lines.length > MAX_CONSOLE_LINES ? lines.slice(lines.length - MAX_CONSOLE_LINES) : lines,
    });
  });

  // A breakpoint binds when the type holding it loads, which is often after
  // `setBreakpoints` answered — and again after every Unity domain reload,
  // since recompiling scripts or entering Play Mode reloads the assembly. The
  // gutter would otherwise show the line as unverified for the rest of the
  // session even though the runtime is armed on it.
  dapClient.on('breakpoint', (body) => {
    const b = body as { breakpoint?: { verified?: boolean; line?: number; source?: { path?: string } } };
    const path = b.breakpoint?.source?.path;
    const line = b.breakpoint?.line;
    if (!path || typeof line !== 'number') return;

    const map = new Map(get().breakpoints);
    for (const [file, list] of map) {
      if (!samePath(file, path)) continue;
      // The runtime may bind below the requested line (a blank line, a
      // comment), so match on either spelling before marking it verified.
      const updated = list.map((bp) =>
        bp.line === line || bp.verified === undefined
          ? { ...bp, verified: b.breakpoint?.verified ?? true }
          : bp,
      );
      map.set(file, updated);
    }
    set({ breakpoints: map });
  });

  const onEnd = () => set({ status: 'terminated', frames: [], scopes: [], variables: new Map(), threads: [] });
  dapClient.on('terminated', onEnd);
  dapClient.on('exited', onEnd);
  dapClient.on('__exited', onEnd);
}
