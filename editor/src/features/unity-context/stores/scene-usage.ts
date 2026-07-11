import { create } from 'zustand';
import { listenScoped } from '../../../utils/tauri-listener';
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
  invalidate: () => void;
}

let loadGeneration = 0;
const inflightByGuid = new Map<string, Promise<AssetUsageEntry[]>>();
const inflightInstanceByGuid = new Map<string, Promise<AssetUsageEntry[]>>();

export const useSceneUsageStore = create<SceneUsageState>((set, get) => ({
  cache: new Map(),
  entriesForActiveScript: null,
  activeScriptPath: null,
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
    set({ activeScriptPath: scriptAbsPath, isLoading: true });

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

  invalidate: () => {
    loadGeneration++;
    inflightByGuid.clear();
    inflightInstanceByGuid.clear();
    set({
      cache: new Map(),
      entriesForActiveScript: null,
      activeScriptPath: null,
      isLoading: false,
      instanceUsageCache: new Map(),
      instanceUsageLoading: new Set(),
    });
  },
}));

let invalidationListenerInitialized = false;
function initInvalidationListener() {
  if (invalidationListenerInitialized) return;
  invalidationListenerInitialized = true;
  listenScoped<{ added: string[]; removed: string[] }>('file-index-changed', (event) => {
    const all = [...(event.payload.added ?? []), ...(event.payload.removed ?? [])];
    const relevant = all.some((p) => {
      const lower = p.toLowerCase();
      return lower.endsWith('.unity') || lower.endsWith('.prefab') || lower.endsWith('.asset');
    });
    if (relevant) {
      useSceneUsageStore.getState().invalidate();
    }
  }).catch(() => {
    invalidationListenerInitialized = false;
  });
}

initInvalidationListener();
