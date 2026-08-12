import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listenScoped } from '../utils/tauri-listener';
import {
  parseGlobList,
  applyBatch,
  applyComplete,
  createSession,
  patchSession,
  sessionForSearchId,
  type SearchSessions,
  type SearchSession,
  type StreamState,
  type SearchBatchPayload,
  type SearchCompletePayload,
} from '../features/search';
import { useProjectContextStore } from './project-context';
import { useWorkspaceStore } from './workspace';

interface SearchState {
  sessions: SearchSessions;
  activeSessionId: string;
  ensureSession: (id: string) => void;
  setActiveSession: (id: string) => void;
  update: (id: string, patch: Partial<SearchSession>) => void;
  search: (id: string, workspacePath: string) => Promise<void>;
  clearResults: (id: string) => void;
  closeSession: (id: string) => void;
}

const DEFAULT_SESSION_ID = 'search://1';

// Monotonic per window, per the backend contract: a higher id supersedes a
// lower one. The backend cursor is per-session (below), so two tabs run
// concurrently; this counter stays global because ids must stay unique.
let searchGeneration = 0;
let listenersPromise: Promise<void> | null = null;

function toStreamState(session: SearchSession): StreamState {
  return {
    results: session.results,
    totalMatches: session.totalMatches,
    fileCount: session.fileCount,
    truncated: session.truncated,
    isSearching: session.isSearching,
    activeSearchId: session.activeSearchId,
    receivedFirstBatch: session.receivedFirstBatch,
  };
}

function applyToSession(
  searchId: number,
  reduce: (state: StreamState) => StreamState,
) {
  useSearchStore.setState((current) => {
    const session = sessionForSearchId(current.sessions, searchId);
    if (!session) return current;
    const before = toStreamState(session);
    const after = reduce(before);
    if (after === before) return current;
    return { sessions: patchSession(current.sessions, session.id, after) };
  });
}

function ensureListeners(): Promise<void> {
  if (!listenersPromise) {
    listenersPromise = Promise.all([
      listenScoped<SearchBatchPayload>('search-results-batch', (event) => {
        applyToSession(event.payload.searchId, (state) =>
          applyBatch(state, event.payload),
        );
      }),
      listenScoped<SearchCompletePayload>('search-complete', (event) => {
        applyToSession(event.payload.searchId, (state) =>
          applyComplete(state, event.payload),
        );
      }),
    ])
      .then(() => undefined)
      .catch((err) => {
        listenersPromise = null;
        throw err;
      });
  }
  return listenersPromise;
}

export const useSearchStore = create<SearchState>((set, get) => ({
  sessions: { [DEFAULT_SESSION_ID]: createSession(DEFAULT_SESSION_ID) },
  activeSessionId: DEFAULT_SESSION_ID,

  ensureSession: (id) =>
    set((s) => (s.sessions[id] ? s : { sessions: { ...s.sessions, [id]: createSession(id) } })),

  setActiveSession: (id) => set({ activeSessionId: id }),

  update: (id, patch) => set((s) => ({ sessions: patchSession(s.sessions, id, patch) })),

  search: async (id, workspacePath) => {
    const session = get().sessions[id];
    if (!session) return;
    // An empty pattern matches every line in the backend — never send one.
    if (!session.query) {
      get().clearResults(id);
      return;
    }

    const gen = ++searchGeneration;
    // Previous results stay visible until the first batch replaces them.
    set((s) => ({
      sessions: patchSession(s.sessions, id, {
        isSearching: true,
        activeSearchId: gen,
        receivedFirstBatch: false,
        searchError: null,
      }),
    }));

    try {
      // Must be attached before the invoke resolves — batches can arrive as
      // soon as the backend spawns its worker thread.
      await ensureListeners();

      const isUnity = useProjectContextStore.getState().isUnityProject;
      const assetsRootPath = useWorkspaceStore.getState().assetsRootPath;
      const searchRoot = isUnity && assetsRootPath ? assetsRootPath : workspacePath;

      await invoke('start_content_search', {
        searchId: gen,
        sessionId: id,
        options: {
          workspacePath: searchRoot,
          query: session.query,
          isRegex: session.isRegex,
          caseSensitive: session.caseSensitive,
          wholeWord: session.wholeWord,
          includePatterns: parseGlobList(session.includePattern),
          excludePatterns: parseGlobList(session.excludePattern),
          includeIgnored: session.includeIgnored,
          contextLines: null,
          fileExtensions: null,
          maxTotalMatches: null,
          maxMatchesPerFile: null,
        },
      });
    } catch (err) {
      if (get().sessions[id]?.activeSearchId === gen) {
        set((s) => ({
          sessions: patchSession(s.sessions, id, {
            isSearching: false,
            searchError: err instanceof Error ? err.message : String(err),
          }),
        }));
      }
    }
  },

  clearResults: (id) => {
    const session = get().sessions[id];
    if (!session) return;
    if (session.isSearching) {
      const gen = ++searchGeneration;
      invoke('cancel_content_search', { searchId: gen, sessionId: id }).catch(() => {
        // Best-effort: late results arrive under a stale id and are dropped.
      });
    }
    set((s) => ({
      sessions: patchSession(s.sessions, id, {
        results: [],
        totalMatches: 0,
        fileCount: 0,
        truncated: false,
        isSearching: false,
        searchError: null,
        activeSearchId: null,
        receivedFirstBatch: false,
        activeExcerptId: null,
      }),
    }));
  },

  closeSession: (id) => {
    get().clearResults(id);
    set((s) => {
      const next = { ...s.sessions };
      delete next[id];
      const activeSessionId =
        s.activeSessionId === id ? (Object.keys(next)[0] ?? DEFAULT_SESSION_ID) : s.activeSessionId;
      if (!next[activeSessionId]) next[activeSessionId] = createSession(activeSessionId);
      return { sessions: next, activeSessionId };
    });
  },
}));

export { DEFAULT_SESSION_ID };
