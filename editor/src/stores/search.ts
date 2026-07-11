import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  parseGlobList,
  applyBatch,
  applyComplete,
  type StreamState,
  type SearchBatchPayload,
  type SearchCompletePayload,
} from '../features/search';
import { useProjectContextStore } from './project-context';
import { useWorkspaceStore } from './workspace';

interface SearchState extends StreamState {
  query: string;
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  includePattern: string;
  excludePattern: string;
  /** Message from the last `start_content_search` rejection (bad regex/glob),
   *  cleared as soon as another search starts. `null` when there's nothing
   *  to show. */
  searchError: string | null;

  setQuery: (query: string) => void;
  toggleRegex: () => void;
  toggleCaseSensitive: () => void;
  toggleWholeWord: () => void;
  setIncludePattern: (pattern: string) => void;
  setExcludePattern: (pattern: string) => void;
  search: (workspacePath: string) => Promise<void>;
  clearResults: () => void;
}

// Monotonically increasing per window, per the B2 backend contract — a
// higher id always supersedes/cancels a lower one, whether via a new
// `start_content_search` or an explicit `cancel_content_search`.
let searchGeneration = 0;

// Lazily registers the two streaming listeners exactly once for the module's
// lifetime (component remounts / React StrictMode double-invocation must not
// register duplicates). `search()` awaits this *before* invoking
// `start_content_search` — the backend can begin emitting `search-results-batch`
// almost immediately after spawning its worker thread, so the listeners must
// already be attached or early batches would be silently dropped.
let listenersPromise: Promise<void> | null = null;

function toStreamState(state: SearchState): StreamState {
  return {
    results: state.results,
    totalMatches: state.totalMatches,
    fileCount: state.fileCount,
    truncated: state.truncated,
    isSearching: state.isSearching,
    activeSearchId: state.activeSearchId,
    receivedFirstBatch: state.receivedFirstBatch,
  };
}

function ensureListeners(): Promise<void> {
  if (!listenersPromise) {
    listenersPromise = Promise.all([
      listen<SearchBatchPayload>('search-results-batch', (event) => {
        useSearchStore.setState((current) => {
          const streamState = toStreamState(current);
          const next = applyBatch(streamState, event.payload);
          // applyBatch returns the exact same reference for a stale id — in
          // that case return `current` itself so zustand's Object.is check
          // skips the update (and any re-renders) entirely.
          return next === streamState ? current : next;
        });
      }),
      listen<SearchCompletePayload>('search-complete', (event) => {
        useSearchStore.setState((current) => {
          const streamState = toStreamState(current);
          const next = applyComplete(streamState, event.payload);
          return next === streamState ? current : next;
        });
      }),
    ])
      .then(() => undefined)
      .catch((err) => {
        // Allow a later call to retry registration instead of permanently
        // wedging the store with a rejected promise.
        listenersPromise = null;
        throw err;
      });
  }
  return listenersPromise;
}

export const useSearchStore = create<SearchState>((set, get) => ({
  query: '',
  isRegex: false,
  caseSensitive: false,
  wholeWord: false,
  includePattern: '',
  excludePattern: '',
  results: [],
  totalMatches: 0,
  fileCount: 0,
  truncated: false,
  isSearching: false,
  activeSearchId: null,
  receivedFirstBatch: false,
  searchError: null,

  setQuery: (query) => set({ query }),
  toggleRegex: () => set((s) => ({ isRegex: !s.isRegex })),
  toggleCaseSensitive: () => set((s) => ({ caseSensitive: !s.caseSensitive })),
  toggleWholeWord: () => set((s) => ({ wholeWord: !s.wholeWord })),
  setIncludePattern: (pattern) => set({ includePattern: pattern }),
  setExcludePattern: (pattern) => set({ excludePattern: pattern }),

  search: async (workspacePath) => {
    const { query, isRegex, caseSensitive, wholeWord, includePattern, excludePattern } = get();
    // Empty query must never reach the backend — an empty pattern matches
    // every line there. This also covers "clear" (query went back to '').
    if (!query) {
      get().clearResults();
      return;
    }

    const gen = ++searchGeneration;
    // D4: previous results stay visible while the new search streams in —
    // only the streaming-control fields flip here. `results`/totals are left
    // alone until the first batch (which REPLACES them, see applyBatch).
    set({
      isSearching: true,
      activeSearchId: gen,
      receivedFirstBatch: false,
      searchError: null,
    });

    try {
      // Must be registered before the invoke resolves — batches can start
      // arriving as soon as the backend spawns its worker thread.
      await ensureListeners();

      const isUnity = useProjectContextStore.getState().isUnityProject;
      const assetsRootPath = useWorkspaceStore.getState().assetsRootPath;
      const searchRoot = isUnity && assetsRootPath ? assetsRootPath : workspacePath;

      await invoke('start_content_search', {
        searchId: gen,
        options: {
          workspacePath: searchRoot,
          query,
          isRegex,
          caseSensitive,
          wholeWord,
          includePatterns: parseGlobList(includePattern),
          excludePatterns: parseGlobList(excludePattern),
          fileExtensions: isUnity ? ['cs'] : null,
          maxTotalMatches: null,
          maxMatchesPerFile: null,
        },
      });
      // No further action here: results arrive via the batch/complete
      // listeners, which check `gen === activeSearchId` themselves.
    } catch (err) {
      // Invalid regex/glob is the only synchronous rejection path. Only
      // apply it if this is still the search the store cares about — a
      // newer search may have already superseded it.
      if (gen === get().activeSearchId) {
        set({
          isSearching: false,
          searchError: err instanceof Error ? err.message : String(err),
        });
      }
    }
  },

  clearResults: () => {
    // Only cancel when a search might actually be in flight — no sense
    // burning a searchId/IPC round-trip when nothing is running.
    if (get().isSearching) {
      const gen = ++searchGeneration;
      invoke('cancel_content_search', { searchId: gen }).catch(() => {
        // Best-effort: if this fails, any late results simply arrive under a
        // stale (no-longer-active) searchId and are dropped by applyBatch/
        // applyComplete once activeSearchId is cleared below.
      });
    }
    set({
      results: [],
      totalMatches: 0,
      fileCount: 0,
      truncated: false,
      isSearching: false,
      searchError: null,
      activeSearchId: null,
      receivedFirstBatch: false,
    });
  },
}));
