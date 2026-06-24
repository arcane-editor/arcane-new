import { create } from 'zustand';
import { listen } from '@tauri-apps/api/event';
import { useWorkspaceStore } from './workspace';
import { useProjectContextStore } from './project-context';
import {
  buildGraph,
  getOwningAssembly as invokeOwningAssembly,
  type AsmdefNode,
} from '../features/asmdef';

export type { AsmdefNode };

interface FileIndexDelta {
  added: string[];
  removed: string[];
}

interface AsmdefState {
  /** Full assembly-definition graph for the current Unity workspace. */
  graph: AsmdefNode[];
  /** filePath → owning assembly name (memoised so we don't re-invoke on render). */
  byFile: Map<string, string>;

  /** Rebuild the graph from disk (calls the Rust scanner). */
  refresh: (workspacePath: string) => Promise<void>;
  /**
   * Resolve a file's owning assembly. Cached per file; pass `force` after the
   * graph changes if you need to bust the cache for a path.
   */
  getOwningAssembly: (filePath: string, force?: boolean) => Promise<string | null>;
  /** Drop the graph and all caches (workspace switch / non-Unity). */
  reset: () => void;
}

export const useAsmdefStore = create<AsmdefState>((set, get) => ({
  graph: [],
  byFile: new Map(),

  refresh: async (workspacePath: string) => {
    try {
      const graph = await buildGraph(workspacePath);
      // Graph changed → owning-assembly answers may have too; clear the cache.
      set({ graph, byFile: new Map() });
    } catch (err) {
      console.warn('[Asmdef] refresh failed:', err);
    }
  },

  getOwningAssembly: async (filePath: string, force = false) => {
    if (!force) {
      const cached = get().byFile.get(filePath);
      if (cached !== undefined) return cached;
    }
    const workspacePath = useWorkspaceStore.getState().workspacePath;
    if (!workspacePath) return null;
    try {
      const owner = await invokeOwningAssembly(workspacePath, filePath);
      set((state) => {
        const byFile = new Map(state.byFile);
        byFile.set(filePath, owner);
        return { byFile };
      });
      return owner;
    } catch (err) {
      console.warn('[Asmdef] getOwningAssembly failed:', err);
      return null;
    }
  },

  reset: () => set({ graph: [], byFile: new Map() }),
}));

// ── file-index-changed → debounced refresh ──────────────────────────────────
// Mirrors the listen() pattern in workspace.ts / scene-usage.ts. A burst of
// asmdef/asmref add/remove events collapses into a single rebuild ~1s later,
// and only inside Unity projects.

const ASMDEF_REFRESH_DEBOUNCE_MS = 1000;
let listenerInitialized = false;
let refreshDebounce: ReturnType<typeof setTimeout> | null = null;

function isAsmdefPath(p: string): boolean {
  const lower = p.toLowerCase();
  return lower.endsWith('.asmdef') || lower.endsWith('.asmref');
}

function initAsmdefIndexListener(): void {
  if (listenerInitialized) return;
  listenerInitialized = true;
  listen<FileIndexDelta>('file-index-changed', (event) => {
    if (!useProjectContextStore.getState().isUnityProject) return;
    const all = [...(event.payload.added ?? []), ...(event.payload.removed ?? [])];
    if (!all.some(isAsmdefPath)) return;

    if (refreshDebounce) clearTimeout(refreshDebounce);
    refreshDebounce = setTimeout(() => {
      refreshDebounce = null;
      const wp = useWorkspaceStore.getState().workspacePath;
      if (wp && useProjectContextStore.getState().isUnityProject) {
        void useAsmdefStore.getState().refresh(wp);
      }
    }, ASMDEF_REFRESH_DEBOUNCE_MS);
  }).catch(() => {
    listenerInitialized = false;
  });
}

export { initAsmdefIndexListener };
