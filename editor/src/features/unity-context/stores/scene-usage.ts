import { create } from 'zustand';
import { listenScoped } from '../../../utils/tauri-listener';
import { shouldInvalidate } from '../services/usage-invalidation';
import {
  findAssetUsages,
  findInstanceUsages,
  readScriptGuid,
  type AssetUsageEntry,
} from '../services/scene-usage-finder';

interface SceneUsageState {
  cache: Map<string, AssetUsageEntry[]>;
  entriesForActiveScript: AssetUsageEntry[] | null;
  activeScriptPath: string | null;
  /** Workspace the active script was loaded against, so a refresh can re-issue. */
  activeWorkspacePath: string | null;
  isLoading: boolean;

  // Level-2: usages of a specific SO instance, keyed by the instance asset's
  // .meta GUID. Populated lazily when the user expands an instance row.
  instanceUsageCache: Map<string, AssetUsageEntry[]>;
  instanceUsageLoading: Set<string>;

  getUsages: (scriptGuid: string) => AssetUsageEntry[] | undefined;
  ensureUsagesForFile: (
    scriptAbsPath: string,
    workspacePath: string,
  ) => Promise<AssetUsageEntry[]>;
  loadForScript: (scriptAbsPath: string, workspacePath: string) => Promise<void>;
  loadInstanceUsages: (instanceAssetGuid: string, workspacePath: string) => Promise<void>;
  /** Drop the active script's cached entries and load them again. */
  refreshActiveScript: () => Promise<void>;
  invalidate: () => void;
}

let loadGeneration = 0;
const inflightByGuid = new Map<string, Promise<AssetUsageEntry[]>>();
const inflightInstanceByGuid = new Map<string, Promise<AssetUsageEntry[]>>();

export const useSceneUsageStore = create<SceneUsageState>((set, get) => ({
  cache: new Map(),
  entriesForActiveScript: null,
  activeScriptPath: null,
  activeWorkspacePath: null,
  isLoading: false,
  instanceUsageCache: new Map(),
  instanceUsageLoading: new Set(),

  getUsages: (scriptGuid) => get().cache.get(scriptGuid),

  ensureUsagesForFile: async (scriptAbsPath, workspacePath) => {
    const guid = await readScriptGuid(scriptAbsPath);
    if (!guid) return [];

    const cached = get().cache.get(guid);
    if (cached) return cached;

    const inflight = inflightByGuid.get(guid);
    if (inflight) return inflight;

    const promise = (async () => {
      let entries: AssetUsageEntry[];
      try {
        entries = await findAssetUsages(workspacePath, guid);
      } catch {
        entries = [];
      }
      const newCache = new Map(get().cache);
      newCache.set(guid, entries);
      set({ cache: newCache });
      return entries;
    })();

    inflightByGuid.set(guid, promise);
    try {
      return await promise;
    } finally {
      inflightByGuid.delete(guid);
    }
  },

  loadForScript: async (scriptAbsPath, workspacePath) => {
    const gen = ++loadGeneration;
    set({
      activeScriptPath: scriptAbsPath,
      activeWorkspacePath: workspacePath,
      isLoading: true,
    });

    const guid = await readScriptGuid(scriptAbsPath);
    if (gen !== loadGeneration) return;

    if (!guid) {
      set({ entriesForActiveScript: [], isLoading: false });
      return;
    }

    const cached = get().cache.get(guid);
    if (cached) {
      set({ entriesForActiveScript: cached, isLoading: false });
      return;
    }

    const entries = await get().ensureUsagesForFile(scriptAbsPath, workspacePath);
    if (gen !== loadGeneration) return;
    set({ entriesForActiveScript: entries, isLoading: false });
  },

  loadInstanceUsages: async (instanceAssetGuid, workspacePath) => {
    if (get().instanceUsageCache.has(instanceAssetGuid)) return;
    if (inflightInstanceByGuid.has(instanceAssetGuid)) {
      await inflightInstanceByGuid.get(instanceAssetGuid);
      return;
    }

    const nextLoading = new Set(get().instanceUsageLoading);
    nextLoading.add(instanceAssetGuid);
    set({ instanceUsageLoading: nextLoading });

    const promise = (async () => {
      let entries: AssetUsageEntry[];
      try {
        entries = await findInstanceUsages(workspacePath, instanceAssetGuid);
      } catch {
        entries = [];
      }
      const newCache = new Map(get().instanceUsageCache);
      newCache.set(instanceAssetGuid, entries);
      const clearedLoading = new Set(get().instanceUsageLoading);
      clearedLoading.delete(instanceAssetGuid);
      set({ instanceUsageCache: newCache, instanceUsageLoading: clearedLoading });
      return entries;
    })();

    inflightInstanceByGuid.set(instanceAssetGuid, promise);
    try {
      await promise;
    } finally {
      inflightInstanceByGuid.delete(instanceAssetGuid);
    }
  },

  refreshActiveScript: async () => {
    const { activeScriptPath, activeWorkspacePath } = get();
    if (!activeScriptPath || !activeWorkspacePath) return;
    const guid = await readScriptGuid(activeScriptPath);
    if (guid) {
      const next = new Map(get().cache);
      next.delete(guid);
      inflightByGuid.delete(guid);
      set({ cache: next });
    }
    await get().loadForScript(activeScriptPath, activeWorkspacePath);
  },

  invalidate: () => {
    loadGeneration++;
    inflightByGuid.clear();
    inflightInstanceByGuid.clear();
    // KEEP activeScriptPath. Clearing it used to leave the panel permanently
    // blank: its effect is keyed on [gate, workspacePath, loadForScript], none
    // of which change when the store invalidates, so nothing ever re-issued the
    // load and the user had to switch files to get the panel back.
    const { activeScriptPath, activeWorkspacePath } = get();
    set({
      cache: new Map(),
      entriesForActiveScript: null,
      isLoading: activeScriptPath !== null,
      instanceUsageCache: new Map(),
      instanceUsageLoading: new Set(),
    });
    if (activeScriptPath && activeWorkspacePath) {
      void get().loadForScript(activeScriptPath, activeWorkspacePath);
    }
  },
}));

/** Unity reimports arrive as a burst; coalesce them into one invalidation. */
const INVALIDATION_DEBOUNCE_MS = 400;
const pendingChangedPaths = new Set<string>();
let invalidationTimer: ReturnType<typeof setTimeout> | null = null;

let invalidationListenerInitialized = false;
function initInvalidationListener() {
  if (invalidationListenerInitialized) return;
  invalidationListenerInitialized = true;
  listenScoped<{ added: string[]; removed: string[] }>('file-index-changed', (event) => {
    const all = [...(event.payload.added ?? []), ...(event.payload.removed ?? [])];
    // Accumulate and fire on a trailing timer: Unity rewrites whole folders on
    // import, so one reimport arrives as many events. `shouldInvalidate` also
    // drops paths this app just wrote itself.
    for (const p of all) pendingChangedPaths.add(p);
    if (invalidationTimer !== null) clearTimeout(invalidationTimer);
    invalidationTimer = setTimeout(() => {
      invalidationTimer = null;
      const batch = [...pendingChangedPaths];
      pendingChangedPaths.clear();
      if (shouldInvalidate(batch)) {
        useSceneUsageStore.getState().invalidate();
      }
    }, INVALIDATION_DEBOUNCE_MS);
  }).catch(() => {
    invalidationListenerInitialized = false;
  });
}

initInvalidationListener();
