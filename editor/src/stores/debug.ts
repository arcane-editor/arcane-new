import { create } from 'zustand';
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
  verified?: boolean;
}

export interface StackFrame {
  id: number;
  name: string;
  path?: string;
  line: number;
  column: number;
}

export interface VariableNode {
  name: string;
  value: string;
  type?: string;
  variablesReference: number; // >0 means expandable
}

export interface Scope {
  name: string;
  variablesReference: number;
}

interface DebugState {
  status: DebugStatus;
  monoAvailable: boolean | null;
  /** Why the debugger isn't available (for a precise, layered message). */
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

  checkMono: () => Promise<boolean>;
  toggleBreakpoint: (file: string, line: number) => void;
  setBreakpointCondition: (file: string, line: number, condition?: string, hitCondition?: string) => void;
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
  status: 'inactive',
  monoAvailable: null,
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

  checkMono: async () => {
    try {
      const info = await invoke<{ available: boolean; mono_path: string | null; adapter_path: string | null }>(
        'check_mono_installed',
      );
      let reason: string | null = null;
      if (!info.available) {
        if (!info.mono_path && !info.adapter_path) {
          reason = 'Mono runtime and debug adapter not found. Install Mono and the mono-debug adapter to enable debugging.';
        } else if (!info.mono_path) {
          reason = 'Mono runtime not found. Install Mono (e.g. brew install mono) to enable debugging.';
        } else {
          reason = 'Mono debug adapter not found. Install the VS Code "Mono Debug" extension or vendor mono-debug.exe.';
        }
      }
      set({ monoAvailable: info.available, unavailableReason: reason });
      return info.available;
    } catch (err) {
      set({ monoAvailable: false, unavailableReason: `Debugger probe failed: ${String(err)}` });
      return false;
    }
  },

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

  setBreakpointCondition: (file, line, condition, hitCondition) => {
    const map = new Map(get().breakpoints);
    const list = [...(map.get(file) ?? [])];
    const bp = list.find((b) => b.line === line);
    if (bp) {
      bp.condition = condition;
      bp.hitCondition = hitCondition;
      map.set(file, list);
      set({ breakpoints: map });
      persistBreakpoints(useWorkspaceStore.getState().workspacePath ?? '', map);
      void syncBreakpointsForFile(file, list);
    }
  },

  attach: async (play) => {
    const notify = useNotificationsStore.getState().addNotification;
    if (!(await get().checkMono())) {
      notify({
        type: 'warning',
        message: get().unavailableReason ?? 'Debugger unavailable.',
        persistent: true,
      });
      return;
    }
    set({ status: 'attaching' });
    try {
      // Resolve the debugger endpoint: prefer the bridge, else the pid-derived port.
      let host = '127.0.0.1';
      let port = 0;
      try {
        const ep = await bridgeRpc.getDebuggerEndpoint();
        host = ep.host;
        port = ep.port;
      } catch {
        notify({
          type: 'warning',
          message: 'Unity bridge not connected — cannot resolve debugger port. Connect the bridge first.',
        });
        set({ status: 'inactive' });
        return;
      }

      bindDapHandlers(set, get);
      await dapClient.start();
      await dapClient.request('initialize', {
        clientID: 'hosted',
        adapterID: 'mono',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
        supportsVariableType: true,
      });
      // attach kicks the session; the 'initialized' event handler then sends
      // breakpoints + configurationDone.
      await dapClient.request('attach', { address: host, port });
      if (play) {
        await useUnityStore.getState().sendPlay();
      }
      set({ status: 'running' });
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
      breakpoints: list.map((b) => ({ line: b.line, condition: b.condition, hitCondition: b.hitCondition })),
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
      await dapClient
        .request('setExceptionBreakpoints', { filters: ['user-unhandled'] })
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

  const onEnd = () => set({ status: 'terminated', frames: [], scopes: [], variables: new Map(), threads: [] });
  dapClient.on('terminated', onEnd);
  dapClient.on('exited', onEnd);
  dapClient.on('__exited', onEnd);
}
