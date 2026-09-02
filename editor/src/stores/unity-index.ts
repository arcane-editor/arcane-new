import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listenScoped } from '../utils/tauri-listener';
import { useWorkspaceStore } from './workspace';
import { useProjectContextStore } from './project-context';
import { useSettingsStore } from './settings';

// ── Types (mirror the Rust serde camelCase shapes) ──────────────────────────

/** A reverse-reference hit: an asset that references a guid. */
export interface RefHit {
  path: string;
  count: number;
}

/** Meta-hygiene findings for the workspace. */
export interface HygieneReport {
  assetsWithoutMeta: string[];
  orphanMetas: string[];
}

/** Small counts summary returned by a build. */
export interface IndexSummary {
  guidCount: number;
  referencedGuidCount: number;
  totalRefHits: number;
  assetsWithoutMeta: number;
  orphanMetas: number;
  fromCache: boolean;
}

interface IndexProgress {
  phase: string;
  done: number;
  total: number;
}

type IndexStatus = 'idle' | 'building' | 'ready' | 'error';

interface FileIndexDelta {
  added: string[];
  removed: string[];
}

interface UnityIndexState {
  status: IndexStatus;
  progress: IndexProgress | null;
  summary: IndexSummary | null;
  error: string | null;
  /**
   * Bumped every time the index content changes — full build AND incremental
   * delta. Consumers that cache index-derived results key on this.
   *
   * `status` is not sufficient: a delta leaves status untouched, so anything
   * watching status alone serves stale results until a full rebuild or an app
   * restart. On a large project deltas are the normal path, so that staleness
   * is permanent in practice.
   */
  indexRevision: number;
  /**
   * Bumped only when a delta touched an `.inputactions` asset.
   *
   * Separate from `indexRevision` on purpose. Reloading the analyzers' input
   * snapshot costs a project scan, so hanging it off the general revision
   * would run that scan on every prefab and scene save. This fires only when
   * the input assets themselves changed.
   */
  inputActionsRevision: number;

  /** Full build (persists + caches in Rust). Background, non-blocking. */
  build: (workspacePath: string, unityVersion: string, force?: boolean) => Promise<void>;
  /** Reverse-reference lookup for a guid. */
  findReferences: (guid: string) => Promise<RefHit[]>;
  /** Forward guid → asset path lookup (cached full map; null if unknown). */
  resolveGuid: (guid: string) => Promise<string | null>;
  /** Meta-hygiene report for the current workspace. */
  hygiene: () => Promise<HygieneReport | null>;
  /** Drop UI state (workspace switch / non-Unity). */
  reset: () => void;
}

// Forward guid → path map cache. Module-level (not store state) so resolving a
// reference doesn't subscribe components to a large map. Invalidated on a fresh
// build and on each incremental delta.
let guidMapCache: Record<string, string> | null = null;
let guidMapInflight: Promise<Record<string, string>> | null = null;

function invalidateGuidMap(): void {
  guidMapCache = null;
  guidMapInflight = null;
}

/**
 * The cached guid → path map, thin-wrapped for direct (non-subscribing)
 * consumers outside this store (e.g. the `@asset` mention category). Same
 * module-level cache as `resolveGuid` — no new fetch, no new subscription.
 */
export function getGuidMap(): Promise<Record<string, string>> {
  return loadGuidMap();
}

async function loadGuidMap(): Promise<Record<string, string>> {
  if (guidMapCache) return guidMapCache;
  if (guidMapInflight) return guidMapInflight;
  const ws = useWorkspaceStore.getState().workspacePath;
  if (!ws) return {};
  guidMapInflight = invoke<Record<string, string>>('unity_index_guid_map', { workspacePath: ws })
    .then((m) => {
      guidMapCache = m;
      guidMapInflight = null;
      return m;
    })
    .catch((err) => {
      console.warn('[UnityIndex] guid_map failed:', err);
      guidMapInflight = null;
      return {};
    });
  return guidMapInflight;
}

export const useUnityIndexStore = create<UnityIndexState>((set) => ({
  status: 'idle',
  progress: null,
  summary: null,
  indexRevision: 0,
  inputActionsRevision: 0,
  error: null,

  build: async (workspacePath, unityVersion, force = false) => {
    set({ status: 'building', error: null, progress: null });
    try {
      const summary = await invoke<IndexSummary>('unity_index_build', {
        workspacePath,
        unityVersion: unityVersion ?? '',
        force,
      });
      invalidateGuidMap();
      set({ status: 'ready', summary, progress: null });
    } catch (err) {
      console.warn('[UnityIndex] build failed:', err);
      set({ status: 'error', error: String(err), progress: null });
    }
  },

  resolveGuid: async (guid) => {
    const map = await loadGuidMap();
    return map[guid] ?? null;
  },

  findReferences: async (guid) => {
    const workspacePath = useWorkspaceStore.getState().workspacePath;
    if (!workspacePath) return [];
    try {
      return await invoke<RefHit[]>('unity_index_find_references', {
        workspacePath,
        guid,
      });
    } catch (err) {
      console.warn('[UnityIndex] findReferences failed:', err);
      return [];
    }
  },

  hygiene: async () => {
    const workspacePath = useWorkspaceStore.getState().workspacePath;
    if (!workspacePath) return null;
    try {
      return await invoke<HygieneReport>('unity_index_hygiene', { workspacePath });
    } catch (err) {
      console.warn('[UnityIndex] hygiene failed:', err);
      return null;
    }
  },

  reset: () => set({ status: 'idle', progress: null, summary: null, error: null }),
}));

// ── unity-index-progress listener ───────────────────────────────────────────
// Coarse build milestones streamed from Rust feed the progress UI.

let progressListenerInitialized = false;

function initProgressListener(): void {
  if (progressListenerInitialized) return;
  progressListenerInitialized = true;
  listenScoped<IndexProgress>('unity-index-progress', (event) => {
    // Only surface progress while a build is in flight.
    if (useUnityIndexStore.getState().status === 'building') {
      useUnityIndexStore.setState({ progress: event.payload });
    }
  }).catch(() => {
    progressListenerInitialized = false;
  });
}

// ── file-index-changed → debounced incremental delta ────────────────────────
// Mirrors the asmdef store listener. A burst of asset add/remove events
// collapses into a single `unity_index_apply_delta` ~1s later, gated on
// isUnityProject + the `unity.index.enabled` setting.

const DELTA_DEBOUNCE_MS = 1000;
let deltaListenerInitialized = false;
let deltaDebounce: ReturnType<typeof setTimeout> | null = null;
let pendingChanged = new Set<string>();
let pendingRemoved = new Set<string>();

// Extensions whose changes affect the GUID / reverse-reference index. Exported
// for consumers (e.g. the `@asset` mention category) that need the same
// index-relevant extension list to filter the guid map to actual assets
// (`.meta` files are index-relevant but aren't themselves assets).
export const INDEX_RELEVANT = [
  '.meta',
  '.unity',
  '.prefab',
  '.asset',
  '.mat',
  '.controller',
  '.anim',
  // `.inputactions` carries no outgoing `guid:` refs, so the Rust reingest is
  // a no-op for it and its GUID already arrives via the `.meta` sidecar. It is
  // listed here for the two things this list actually gates: the `@asset`
  // mention category, and the `indexRevision` bump that tells consumers (the
  // analyzers' input snapshot) that the asset changed on disk.
  '.inputactions',
];

function isIndexRelevant(p: string): boolean {
  const lower = p.toLowerCase();
  return INDEX_RELEVANT.some((ext) => lower.endsWith(ext));
}

function indexEnabled(): boolean {
  return (
    useProjectContextStore.getState().isUnityProject &&
    useSettingsStore.getState().getSetting('unity.index.enabled') === true
  );
}

function initDeltaListener(): void {
  if (deltaListenerInitialized) return;
  deltaListenerInitialized = true;
  listenScoped<FileIndexDelta>('file-index-changed', (event) => {
    if (!indexEnabled()) return;

    const added = (event.payload.added ?? []).filter(isIndexRelevant);
    const removed = (event.payload.removed ?? []).filter(isIndexRelevant);
    if (added.length === 0 && removed.length === 0) return;

    for (const p of added) pendingChanged.add(p);
    for (const p of removed) {
      pendingRemoved.add(p);
      // A path can't be both changed and removed in the same flush.
      pendingChanged.delete(p);
    }

    if (deltaDebounce) clearTimeout(deltaDebounce);
    deltaDebounce = setTimeout(() => {
      deltaDebounce = null;
      const workspacePath = useWorkspaceStore.getState().workspacePath;
      const changed = [...pendingChanged];
      const removedList = [...pendingRemoved];
      pendingChanged = new Set();
      pendingRemoved = new Set();
      if (!workspacePath || !indexEnabled()) return;
      if (changed.length === 0 && removedList.length === 0) return;

      // Bumped separately below so a prefab save does not trigger the
      // analyzers' `.inputactions` rescan (see `inputActionsRevision`).
      const inputTouched = [...changed, ...removedList].some((p) =>
        p.toLowerCase().endsWith('.inputactions'),
      );

      void invoke('unity_index_apply_delta', {
        workspacePath,
        changed,
        removed: removedList,
      })
        .then(() => {
          invalidateGuidMap();
          useUnityIndexStore.setState((s) => ({
            indexRevision: s.indexRevision + 1,
            inputActionsRevision: s.inputActionsRevision + (inputTouched ? 1 : 0),
          }));
        })
        .catch((err) => {
          console.warn('[UnityIndex] apply_delta failed:', err);
        });
    }, DELTA_DEBOUNCE_MS);
  }).catch(() => {
    deltaListenerInitialized = false;
  });
}

/**
 * Install the unity-index listeners (progress + incremental delta). Idempotent
 * and inert for non-Unity projects (the delta listener self-gates). Call once
 * on app mount.
 */
export function initUnityIndexListeners(): void {
  initProgressListener();
  initDeltaListener();
}
