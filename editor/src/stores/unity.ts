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
} from '../types/unity';
import { parseStackTrace } from '../types/unity';
import { useWorkspaceStore } from './workspace';
import { useNotificationsStore, notify } from './notifications';
import { isBridgeInstalled, installBridge } from '../features/unity-bridge';

const MAX_LOG_ENTRIES = 10_000;
/** How long after a disconnect we assume Unity is mid-domain-reload (not gone). */
const RELOAD_GRACE_MS = 15_000;

/** UI-facing bridge connection state for the status cluster. */
export type BridgeState = 'not-installed' | 'disconnected' | 'connected' | 'reloading';

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

  startIpc: (workspacePath: string) => Promise<void>;
  stopIpc: () => Promise<void>;
  sendPlay: () => Promise<void>;
  sendPause: () => Promise<void>;
  sendStop: () => Promise<void>;
  sendStep: () => Promise<void>;
  clearLogs: () => void;
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
      // Don't override a live connection; only adjust the idle state.
      bridgeState: state.connected
        ? 'connected'
        : state.bridgeState === 'reloading'
          ? 'reloading'
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
    set({ connected: false, projectInfo: null, playState: 'Stopped', isCompiling: false });
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
        // A drop is usually a domain reload — show 'reloading' briefly, then
        // demote to 'disconnected' if Unity doesn't reconnect.
        set({ connected: false, playState: 'Stopped', isCompiling: false, bridgeState: 'reloading' });
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

    const u6 = await listenScoped<OpenFilePayload>('unity-open-file', (event) => {
      const { path } = event.payload;
      const fileName = path.split('/').pop() ?? path;
      useWorkspaceStore.getState().openFile(path, fileName);
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
    const u8 = await listenScoped<void>('unity-package-stale', () => {
      if (get().packageStale) return; // already prompted this session
      set({ packageStale: true });

      const workspacePath = useWorkspaceStore.getState().workspacePath;
      useNotificationsStore.getState().addNotification({
        type: 'warning',
        persistent: true,
        message:
          'Unity is running but the Arcane package is missing or out of date. ' +
          'Install it to connect the editor.',
        actions: workspacePath
          ? [
              {
                label: 'Install package',
                run: () => {
                  installBridge(workspacePath)
                    .then(() => {
                      set({ packageStale: false, bridgeInstalled: true });
                      notify.success('Arcane package installed — Unity will connect shortly.');
                    })
                    .catch((e) => notify.error(`Could not install the Arcane package: ${e}`));
                },
              },
            ]
          : undefined,
      });
    });

    unlisteners = [u1, u2, u3, u4, u5, u6, u7, u8];
    set({ listenersActive: true });
  },

  teardownListeners: () => {
    for (const unlisten of unlisteners) {
      unlisten();
    }
    unlisteners = [];
    set({ listenersActive: false });
  },
}));
