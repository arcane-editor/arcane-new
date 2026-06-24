/**
 * Graphify store — tracks the status of the per-workspace AST code graph.
 *
 * Detection runs whenever a workspace opens. If the on-disk graph exists, it
 * loads its summary; otherwise it reports `absent` so the workspace layer can
 * surface a "build graph" toast. Build progress is streamed by the Rust side
 * over the `graphify-build-progress` Tauri event.
 */

import { create } from 'zustand';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  graphifyBuild,
  graphifyCheck,
  graphifyLoadSummary,
  enrichGraph,
  type GraphifyBuildOpts,
  type GraphifySummary,
  type GraphEnrichment,
} from '../features/graphify';

const STALE_MS = 24 * 60 * 60 * 1000; // 24h

export type GraphifyStatus = 'absent' | 'present' | 'stale' | 'building' | 'error';

interface GraphifyState {
  status: GraphifyStatus;
  graphPath: string | null;
  summary: GraphifySummary | null;
  /** Server-side AI semantic layer over the local graph (best-effort, may be null). */
  enrichment: GraphEnrichment | null;
  lastBuiltAt: number | null;
  progressMessage: string | null;
  errorMessage: string | null;
  sidecarAvailable: boolean | null;

  detect: (workspacePath: string) => Promise<void>;
  build: (workspacePath: string, opts?: GraphifyBuildOpts) => Promise<void>;
  enrich: (workspacePath: string) => Promise<void>;
  setProgressMessage: (msg: string | null) => void;
  reset: () => void;
}

export const useGraphifyStore = create<GraphifyState>((set, get) => ({
  status: 'absent',
  graphPath: null,
  summary: null,
  enrichment: null,
  lastBuiltAt: null,
  progressMessage: null,
  errorMessage: null,
  sidecarAvailable: null,

  detect: async (workspacePath: string) => {
    // Cheap sidecar availability check; only runs once per workspace switch.
    if (get().sidecarAvailable === null) {
      try {
        const check = await graphifyCheck();
        set({ sidecarAvailable: check.available });
      } catch {
        set({ sidecarAvailable: false });
      }
    }
    if (get().sidecarAvailable === false) {
      // Sidecar isn't bundled (or it's the dev stub). This is a calm
      // "feature not active" state, not an error — the badge has a dedicated
      // 'graph: unavailable' render path keyed on sidecarAvailable directly.
      set({ status: 'absent', errorMessage: null });
      return;
    }

    try {
      const result = await graphifyLoadSummary(workspacePath);
      if (!result.available) {
        set({
          status: 'absent',
          graphPath: null,
          summary: null,
          lastBuiltAt: null,
          errorMessage: null,
        });
        return;
      }
      const age = result.last_built_at_ms ? Date.now() - result.last_built_at_ms : null;
      const stale = age !== null && age > STALE_MS;
      set({
        status: stale ? 'stale' : 'present',
        graphPath: result.graph_path,
        summary: result.summary,
        lastBuiltAt: result.last_built_at_ms,
        errorMessage: null,
      });
    } catch (e) {
      set({
        status: 'error',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
  },

  build: async (workspacePath: string, opts?: GraphifyBuildOpts) => {
    if (get().sidecarAvailable === false) {
      // No-op when the sidecar isn't really there. The badge already shows
      // the right state; don't poison the store with an error.
      return;
    }
    set({ status: 'building', progressMessage: 'starting…', errorMessage: null });

    // Stream progress lines from the sidecar's stdout into the store so the
    // status badge can display them as a live indicator.
    let unlisten: UnlistenFn | null = null;
    try {
      unlisten = await listen<string>('graphify-build-progress', (event) => {
        const line = String(event.payload ?? '').replace(/^\[arcane-graph\]\s*/, '');
        if (line) set({ progressMessage: line });
      });
    } catch {
      // No progress stream; build still proceeds.
    }

    try {
      const result = await graphifyBuild(workspacePath, opts);
      const loaded = await graphifyLoadSummary(workspacePath);
      set({
        status: 'present',
        graphPath: result.graph_path,
        summary: loaded.summary,
        lastBuiltAt: loaded.last_built_at_ms,
        progressMessage: null,
      });
      // Fire-and-forget AI enrichment — never let a server/network failure
      // break the local build.
      void get().enrich(workspacePath);
    } catch (e) {
      set({
        status: 'error',
        progressMessage: null,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    } finally {
      try { unlisten?.(); } catch { /* ignore */ }
    }
  },

  enrich: async (workspacePath: string) => {
    try {
      const enrichment = await enrichGraph(workspacePath);
      // Only overwrite if we got something — keep any prior enrichment otherwise.
      if (enrichment) set({ enrichment });
    } catch {
      // Best-effort; ignore.
    }
  },

  setProgressMessage: (msg) => set({ progressMessage: msg }),

  reset: () =>
    set({
      status: 'absent',
      graphPath: null,
      summary: null,
      enrichment: null,
      lastBuiltAt: null,
      progressMessage: null,
      errorMessage: null,
      // Keep sidecarAvailable across workspace switches — it's a host-level
      // capability, not workspace-specific.
    }),
}));
