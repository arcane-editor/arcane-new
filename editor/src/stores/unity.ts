import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { listenScoped } from '../utils/tauri-listener';
import type {
  UnityLogEntry,
  UnityProjectInfo,
  UnityPlayState,
  ConnectionChangedPayload,
  PlaystateChangedPayload,
  CompilationPayload,
  OpenFilePayload,
  StalePackagePayload,
} from '../types/unity';
import { parseStackTrace } from '../types/unity';
import { useWorkspaceStore } from './workspace';
import { useNotificationsStore, notify } from './notifications';
import { isBridgeInstalled, installBridge } from '../features/unity-bridge';
import { setPendingNavigation } from '../utils/editor-navigation';
import { raiseCurrentWindow } from '../utils/window-focus';

const MAX_LOG_ENTRIES = 10_000;
/** How long after a disconnect we assume Unity is mid-domain-reload (not gone). */
const RELOAD_GRACE_MS = 15_000;

/** UI-facing bridge connection state for the status cluster. */
export type BridgeState =
  | 'not-installed'
  | 'disconnected'
  | 'connected'
  | 'reloading'
  | 'connecting';

interface UnityState {
  connected: boolean;
  projectInfo: UnityProjectInfo | null;
  playState: UnityPlayState;
  isCompiling: boolean;
  logs: UnityLogEntry[];
  listenersActive: boolean;
  /** Whether the bridge package is embedded in the current project. */
  bridgeInstalled: boolean;
  /** Coarse bridge connection state for the status cluster / banner. */
  bridgeState: BridgeState;
  /** Last full compilation report (errors/warnings) — drives compile feedback. */
  lastCompilation: CompilationPayload | null;
  /**
   * Unity has the project open but no bridge journal ever appeared, so the
   * package is missing or predates the journal transport. Distinguishes that
   * from the ordinary "Unity just isn't running" case, which otherwise looks
   * identical from here — both are simply "never connected".
   */
  packageStale: boolean;
  /**
   * Whether Unity's MAIN THREAD is currently servicing work.
   *
   * Deliberately separate from `connected`. Unity parks its main thread while
   * its window is unfocused, but the bridge's worker thread keeps heartbeating
   * from a background thread — so `connected` stayed true through the exact
   * window in which every RPC was timing out against an editor that could not
   * answer, and the UI showed a healthy green bridge the whole time.
   */
  editorAwake: boolean;
  /** Whether the package can wake Unity's main thread without stealing focus. */
  editorCanWake: boolean;
  /**
   * Bumped whenever Unity reports that a QUEUED asset import actually ran.
   * Queued commands ack on acceptance, so this is the only honest "it happened".
   */
  refreshCompletedAt: number;
  /**
   * Whether Unity had a compile in flight when that import finished. Positive
   * evidence: silence alone cannot tell "nothing to build" from "a compile
   * Unity scheduled for a tick it has not run yet".
   */
  refreshCompiling: boolean;

  startIpc: (workspacePath: string) => Promise<void>;
  stopIpc: () => Promise<void>;
  /**
   * Force the bridge to re-handshake now. Publishes a fresh `ideSessionId`, which
   * is the only signal that makes Unity tear down a session it still believes is
   * healthy — the state the bridge used to get permanently stuck in.
   */
  reconnect: () => Promise<void>;
  sendPlay: () => Promise<void>;
  sendPause: () => Promise<void>;
  sendStop: () => Promise<void>;
  sendStep: () => Promise<void>;
  clearLogs: () => void;
  /**
   * Drop everything that belongs to the project being left.
   *
   * Console history and the last compile report survived a workspace switch,
   * so project A's errors and stack traces were shown as project B's — and
   * clicking one navigated into a file that is not in the open project.
   */
  resetForWorkspaceChange: () => void;
  /** Reconcile the UI against the backend's actual connection state. */
  syncStatus: () => Promise<void>;
  setupListeners: () => Promise<void>;
  teardownListeners: () => void;
  refreshBridgeInstalled: (workspacePath: string) => Promise<void>;
}

let unlisteners: UnlistenFn[] = [];
/** Timer that demotes 'reloading' → 'disconnected' if Unity doesn't come back. */
let reloadGraceTimer: ReturnType<typeof setTimeout> | null = null;

export const useUnityStore = create<UnityState>((set, get) => ({
  connected: false,
  projectInfo: null,
  playState: 'Stopped',
  isCompiling: false,
  logs: [],
  listenersActive: false,
  bridgeInstalled: false,
  bridgeState: 'disconnected',
  lastCompilation: null,
  packageStale: false,
  // Optimistic until Unity says otherwise, matching the Rust side's default:
  // a bridge that has not heartbeated yet is not a sleeping editor.
  editorAwake: true,
  editorCanWake: false,
  refreshCompletedAt: 0,
  refreshCompiling: false,

  startIpc: async (workspacePath: string) => {
    try {
      await invoke('unity_ipc_start', { workspacePath });
      if (!get().listenersActive) {
        await get().setupListeners();
      }
      // Reflect whether the bridge package is embedded yet (drives the banner).
      await get().refreshBridgeInstalled(workspacePath);
    } catch (err) {
      console.warn('[Unity] IPC start failed:', err);
    }
  },

  refreshBridgeInstalled: async (workspacePath: string) => {
    const installed = await isBridgeInstalled(workspacePath);
    set((state) => ({
      bridgeInstalled: installed,
      // Don't override a live connection or an in-flight attempt; only adjust
      // the idle state.
      bridgeState: state.connected
        ? 'connected'
        : state.bridgeState === 'reloading' || state.bridgeState === 'connecting'
          ? state.bridgeState
          : installed
            ? 'disconnected'
            : 'not-installed',
    }));
  },

  stopIpc: async () => {
    try {
      await invoke('unity_ipc_stop');
    } catch {
      // Ignore
    }
    get().teardownListeners();
    set({
      connected: false,
      projectInfo: null,
      playState: 'Stopped',
      isCompiling: false,
      editorAwake: true,
    });
  },

  reconnect: async () => {
    if (reloadGraceTimer) {
      clearTimeout(reloadGraceTimer);
      reloadGraceTimer = null;
    }
    // Show the attempt immediately. The backend re-arms within one poll tick,
    // but the handshake needs Unity's discovery poll (~1s) to come back, and an
    // unacknowledged click reads as a dead button.
    set({ connected: false, bridgeState: 'connecting', packageStale: false });
    try {
      await invoke('unity_ipc_reconnect');
    } catch (err) {
      set((state) => ({
        bridgeState: state.bridgeInstalled ? 'disconnected' : 'not-installed',
      }));
      notify.error(`Could not reconnect to Unity: ${String(err)}`);
      return;
    }
    // Unity re-handshakes on its own schedule; fall back to the idle state if it
    // never answers, exactly as the disconnect path does.
    reloadGraceTimer = setTimeout(() => {
      reloadGraceTimer = null;
      set((state) =>
        state.connected
          ? {}
          : { bridgeState: state.bridgeInstalled ? 'disconnected' : 'not-installed' },
      );
    }, RELOAD_GRACE_MS);
  },

  sendPlay: async () => {
    const msg = JSON.stringify({ type: 'enter_playmode' });
    await invoke('unity_ipc_send', { messageJson: msg }).catch(() => {});
  },

  sendPause: async () => {
    const msg = JSON.stringify({ type: 'pause' });
    await invoke('unity_ipc_send', { messageJson: msg }).catch(() => {});
  },

  sendStop: async () => {
    const msg = JSON.stringify({ type: 'exit_playmode' });
    await invoke('unity_ipc_send', { messageJson: msg }).catch(() => {});
  },

  sendStep: async () => {
    const msg = JSON.stringify({ type: 'step' });
    await invoke('unity_ipc_send', { messageJson: msg }).catch(() => {});
  },

  clearLogs: () => set({ logs: [] }),

  resetForWorkspaceChange: () =>
    set({
      logs: [],
      lastCompilation: null,
      playState: 'Stopped',
      isCompiling: false,
      projectInfo: null,
      packageStale: false,
      editorAwake: true,
      editorCanWake: false,
      refreshCompletedAt: 0,
      refreshCompiling: false,
      // `connected` and the listeners are owned by the IPC lifecycle, which
      // setWorkspace restarts separately — clearing them here would race it.
    }),

  syncStatus: async () => {
    type Status = {
      connected: boolean;
      running: boolean;
      editorAwake: boolean;
      editorCanWake: boolean;
    };
    let status: Status;
    try {
      status = await invoke<Status>('unity_ipc_status');
    } catch {
      return; // no session for this window — leave the UI as it is
    }
    // Liveness is reconciled UNCONDITIONALLY, even when `connected` is
    // unchanged. `unity-editor-awake` fires only on a change, and startIpc
    // awaits unity_ipc_start before attaching listeners — so the first
    // awake→asleep transition can be emitted with nobody listening, leaving the
    // store permanently convinced Unity is servicing work when it is parked.
    const liveness = {
      editorAwake: status.editorAwake,
      editorCanWake: status.editorCanWake,
    };
    set((state) => {
      if (state.connected === status.connected) return liveness;
      return status.connected
        ? {
            ...liveness,
            connected: true,
            bridgeInstalled: true,
            bridgeState: 'connected' as const,
            packageStale: false,
          }
        : {
            ...liveness,
            connected: false,
            bridgeState: state.bridgeInstalled
              ? ('disconnected' as const)
              : ('not-installed' as const),
          };
    });
  },

  setupListeners: async () => {
    // Clean up any existing listeners
    get().teardownListeners();

    const u1 = await listenScoped<ConnectionChangedPayload>('unity-connection-changed', (event) => {
      const isConnected = event.payload.connected;
      if (reloadGraceTimer) {
        clearTimeout(reloadGraceTimer);
        reloadGraceTimer = null;
      }
      if (isConnected) {
        set({
          connected: true,
          projectInfo: event.payload.info ?? get().projectInfo,
          bridgeInstalled: true, // it connected, so it's installed
          bridgeState: 'connected',
          packageStale: false, // a handshake proves the package is current
        });
      } else {
        // A domain reload no longer looks like a drop — Unity announces it as
        // `reloading` and the connection is held open across it. So a drop here
        // is a genuine loss, and the backend is already re-arming: show
        // 'connecting' while that plays out, then settle to 'disconnected'.
        set({
          connected: false,
          playState: 'Stopped',
          isCompiling: false,
          bridgeState: 'connecting',
          // Liveness belongs to the session that reported it. Carrying "asleep"
          // into a reconnect would have the next handshake arrive already
          // believing Unity is parked.
          editorAwake: true,
        });
        reloadGraceTimer = setTimeout(() => {
          reloadGraceTimer = null;
          set((state) =>
            state.connected
              ? {}
              : { bridgeState: state.bridgeInstalled ? 'disconnected' : 'not-installed' },
          );
        }, RELOAD_GRACE_MS);
      }
    });

    const u2 = await listenScoped<UnityLogEntry>('unity-log', (event) => {
      const entry = { ...event.payload, parsedFrames: parseStackTrace(event.payload.stackTrace ?? '') };
      set((state) => {
        const logs = [...state.logs, entry];
        return { logs: logs.length > MAX_LOG_ENTRIES ? logs.slice(-MAX_LOG_ENTRIES) : logs };
      });
    });

    const u3 = await listenScoped<UnityLogEntry[]>('unity-log-batch', (event) => {
      const entries = (event.payload ?? []).map((e) => ({
        ...e,
        parsedFrames: parseStackTrace(e.stackTrace ?? ''),
      }));
      set((state) => {
        const logs = [...state.logs, ...entries];
        return { logs: logs.length > MAX_LOG_ENTRIES ? logs.slice(-MAX_LOG_ENTRIES) : logs };
      });
    });

    const u4 = await listenScoped<PlaystateChangedPayload>('unity-playstate-changed', (event) => {
      set({
        playState: event.payload.state,
        isCompiling: event.payload.isCompiling,
      });
    });

    const u5 = await listenScoped<CompilationPayload>('unity-compilation', (event) => {
      // started=true → compiling; started=false → finished (carries the report).
      set({
        isCompiling: event.payload.started,
        lastCompilation: event.payload.started ? get().lastCompilation : event.payload,
      });
    });

    // Unity asking this window to open a script — the warm path behind
    // double-clicking a file in its Project window. It goes over the bridge
    // rather than relaunching the app, so nothing else brings us forward:
    // raising is part of honouring the request, not a nicety.
    const u6 = await listenScoped<OpenFilePayload>('unity-open-file', (event) => {
      const { path, line, column } = event.payload;
      const fileName = path.split('/').pop() ?? path;
      // Before openFile, not after: EditorPanel consumes the pending
      // navigation on the activeFilePath effect that openFile triggers.
      if (line !== undefined) {
        setPendingNavigation({ line, column: column ?? 1 });
      }
      void raiseCurrentWindow();
      void useWorkspaceStore.getState().openFile(path, fileName);
    });

    const u7 = await listenScoped<{ ideProtocol: number; bridgeProtocol: number }>(
      'unity-bridge-version-mismatch',
      (event) => {
        useNotificationsStore.getState().addNotification({
          type: 'warning',
          message: `Unity bridge protocol mismatch (IDE v${event.payload.ideProtocol}, bridge v${event.payload.bridgeProtocol}). Reinstall the bridge package.`,
          persistent: true,
        });
      },
    );

    // Unity is demonstrably running (Library/EditorInstance.json names a live
    // pid) but nothing ever wrote a bridge journal. Without this the UI would sit
    // on "waiting for Unity" forever, which is indistinguishable from Unity
    // simply being closed — the single worst failure mode of the hard protocol
    // switch, and the one a user cannot diagnose on their own.
    const u8 = await listenScoped<StalePackagePayload>('unity-package-stale', (event) => {
      if (get().packageStale) return; // already prompted this session
      set({ packageStale: true });

      const { reason, installed, required } = event.payload;
      // 'outdated' means it handshook and then misbehaves in ways that point
      // nowhere near the install being old, so name the versions explicitly.
      const message =
        reason === 'outdated'
          ? `The UnityIDE Unity package is out of date (${installed ?? 'unknown'}; needs ${required}). ` +
            'Update it — a stale package fails in confusing ways.'
          : 'Unity is running but the UnityIDE package is missing. Install it to connect the editor.';

      const workspacePath = useWorkspaceStore.getState().workspacePath;
      useNotificationsStore.getState().addNotification({
        type: 'warning',
        persistent: true,
        message,
        actions: workspacePath
          ? [
              {
                label: reason === 'outdated' ? 'Update package' : 'Install package',
                run: () => {
                  installBridge(workspacePath)
                    .then(() => {
                      set({ packageStale: false, bridgeInstalled: true });
                      notify.success('UnityIDE package installed — Unity will connect shortly.');
                    })
                    .catch((e) => notify.error(`Could not install the UnityIDE package: ${e}`));
                },
              },
            ]
          : undefined,
      });
    });

    // Unity is rebuilding its AppDomain after a script change. The session
    // survives it — the journal simply goes quiet and resumes at its persisted
    // offset — so this is a distinct state, not a disconnect. Before Unity
    // announced it, the only signal was silence, and silence past the liveness
    // deadline was indistinguishable from Unity dying.
    const u9 = await listenScoped<{ reloading: boolean }>('unity-reloading', (event) => {
      set((state) => {
        if (!state.connected) return {};
        return { bridgeState: event.payload.reloading ? 'reloading' : 'connected' };
      });
    });

    // Unity's main thread going to sleep or waking up. This is what lets the
    // agent gate say "your write landed, Unity is asleep" instead of stalling a
    // turn for ninety seconds against an unfocused window.
    const u10 = await listenScoped<{
      awake: boolean;
      editorIdleMs: number;
      canWake: boolean;
    }>('unity-editor-awake', (event) => {
      const { awake, canWake } = event.payload;
      set({ editorAwake: awake, editorCanWake: canWake });
    });

    // A queued import actually ran. The rpc_response for a queued command only
    // ever meant "accepted", so this is the first moment anything may conclude
    // that Unity had nothing to compile.
    const u11 = await listenScoped<{ compileRequested?: boolean; compiling?: boolean }>(
      'unity-refresh-completed',
      (event) => {
        // Deliberately does NOT touch `editorAwake`. Liveness is owned by the
        // heartbeat, and Rust emits `unity-editor-awake` only when the value
        // CHANGES — so synthesising an "awake" here left the store believing
        // that forever, since Rust (still holding `false`) had no change to
        // report. The next write then never saw a parked editor and waited out
        // the full 90s cap, reinstating the stall this whole path removes.
        set({
          refreshCompletedAt: Date.now(),
          refreshCompiling: event.payload?.compiling === true,
        });
      },
    );

    unlisteners = [u1, u2, u3, u4, u5, u6, u7, u8, u9, u10, u11];
    set({ listenersActive: true });

    // Reconcile against the backend now that we are listening. Events emitted
    // before the listeners attached are gone, and a UI that believes it is
    // disconnected while the bridge is live hides every Unity panel behind a
    // banner for no reason.
    await get().syncStatus();
  },

  teardownListeners: () => {
    for (const unlisten of unlisteners) {
      unlisten();
    }
    unlisteners = [];
    set({ listenersActive: false });
  },
}));
