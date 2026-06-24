import { create } from 'zustand';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { bridgeRpc, type SceneHierarchy, type SelectionObject } from '../features/unity-bridge';
import { useUnityStore } from './unity';

/**
 * Live scene-state mirror, fed by the Unity bridge. The single source of truth
 * for both the Hierarchy panel (F-4.3) and the AI `@scene`/`@object` mentions
 * (F-5.5) — build the event wiring + RPC plumbing once, read from it twice.
 *
 * Everything degrades gracefully when Unity is disconnected: `refresh()` clears
 * to a "not-connected" state rather than throwing.
 */
interface UnitySceneState {
  hierarchy: SceneHierarchy | null;
  selection: SelectionObject[];
  loading: boolean;
  /** 'not-connected' when the bridge is down, else an RPC error message or null. */
  error: string | null;
  lastFetched: number;
  listenersActive: boolean;

  /** Force a re-fetch of hierarchy + selection. No-op-ish when disconnected. */
  refresh: () => Promise<void>;
  /** Return the cached hierarchy if fresh enough, else refresh first. */
  ensureFresh: (maxAgeMs?: number) => Promise<SceneHierarchy | null>;
  setupListeners: () => Promise<void>;
  teardownListeners: () => void;
  reset: () => void;
}

let unlisteners: UnlistenFn[] = [];
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let unsubConn: (() => void) | null = null;

export const useUnitySceneStore = create<UnitySceneState>((set, get) => ({
  hierarchy: null,
  selection: [],
  loading: false,
  error: null,
  lastFetched: 0,
  listenersActive: false,

  refresh: async () => {
    if (!useUnityStore.getState().connected) {
      set({ hierarchy: null, selection: [], error: 'not-connected', loading: false });
      return;
    }
    set({ loading: true, error: null });
    try {
      const [hierarchy, sel] = await Promise.all([
        bridgeRpc.getSceneHierarchy(),
        bridgeRpc.getSelection().catch(() => ({ objects: [] as SelectionObject[] })),
      ]);
      set({
        hierarchy,
        selection: sel.objects ?? [],
        loading: false,
        error: null,
        lastFetched: Date.now(),
      });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  ensureFresh: async (maxAgeMs = 2000) => {
    const { hierarchy, lastFetched } = get();
    if (hierarchy && Date.now() - lastFetched < maxAgeMs) return hierarchy;
    await get().refresh();
    return get().hierarchy;
  },

  setupListeners: async () => {
    get().teardownListeners();

    const scheduleRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void get().refresh();
      }, 300);
    };

    const u1 = await listen('unity-hierarchy-changed', scheduleRefresh);
    const u2 = await listen('unity-selection-changed', () => {
      // Selection is cheap — update it eagerly (independent of the hierarchy
      // debounce) so editor-side selection reflects in <500ms.
      void bridgeRpc
        .getSelection()
        .then((s) => set({ selection: s.objects ?? [] }))
        .catch(() => {});
    });
    unlisteners = [u1, u2];

    // Refresh on (re)connect; clear on disconnect.
    unsubConn = useUnityStore.subscribe((state, prev) => {
      if (state.connected && !prev.connected) void get().refresh();
      else if (!state.connected && prev.connected) {
        set({ hierarchy: null, selection: [], error: 'not-connected' });
      }
    });

    set({ listenersActive: true });
  },

  teardownListeners: () => {
    for (const u of unlisteners) u();
    unlisteners = [];
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    if (unsubConn) {
      unsubConn();
      unsubConn = null;
    }
    set({ listenersActive: false });
  },

  reset: () => {
    get().teardownListeners();
    set({ hierarchy: null, selection: [], loading: false, error: null, lastFetched: 0 });
  },
}));
