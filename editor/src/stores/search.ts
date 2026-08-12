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
  resolveCaseSensitive,
  clearFileLineCache,
  searchSignature,
  type SearchSessions,
  type SearchSession,
  type StreamState,
  type SearchBatchPayload,
  type SearchCompletePayload,
} from '../features/search';
import { useProjectContextStore } from './project-context';
import { useWorkspaceStore } from './workspace';
import { useSettingsStore } from './settings';

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
        // Reset, not left pointing at the rejected promise: every future
        // `search()` awaits this same promise, so a permanent failure here
        // would wedge the store — no search could ever run again, forever,
        // even if whatever transient condition caused the listen() calls to
        // reject has since cleared. Resetting to `null` means the NEXT call
        // gets a fresh attempt instead.
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
    // `expanded`/`activeExcerptId` are cleared here too, not just the file-line
    // cache below: both name excerpts from the PREVIOUS result set by id
    // (`path:startLine`), and a new search can produce an excerpt that reuses
    // one of those ids for entirely different content (same file, same start
    // line, different surrounding matches) — without this it would silently
    // inherit the old up/down counts and render pre-expanded, or `active`
    // would point at an excerpt that no longer exists.
    set((s) => ({
      sessions: patchSession(s.sessions, id, {
        isSearching: true,
        activeSearchId: gen,
        receivedFirstBatch: false,
        searchError: null,
        expanded: {},
        activeExcerptId: null,
        // Stamped from the pre-invoke `session` snapshot — the same query/
        // option values `SearchQueryBar`'s auto-search effect will compare
        // its own freshly computed signature against on a later remount.
        searchedSignature: searchSignature(session),
      }),
    }));

    try {
      // Must be attached before the invoke resolves — batches can arrive as
      // soon as the backend spawns its worker thread.
      await ensureListeners();

      const isUnity = useProjectContextStore.getState().isUnityProject;
      const assetsRootPath = useWorkspaceStore.getState().assetsRootPath;
      const searchRoot = isUnity && assetsRootPath ? assetsRootPath : workspacePath;

      const settings = useSettingsStore.getState().settings;
      const caseSensitive = resolveCaseSensitive(
        session.query,
        session.caseSensitive,
        settings['search.useSmartcase'],
      );

      // Dropped here, not just on session creation: stale lines from a
      // PREVIOUS search must never splice into results computed against a
      // file that has since changed. Sits right before the invoke so no
      // early return above it can start a search while skipping this.
      clearFileLineCache();
      await invoke('start_content_search', {
        searchId: gen,
        sessionId: id,
        options: {
          workspacePath: searchRoot,
          query: session.query,
          isRegex: session.isRegex,
          caseSensitive,
          wholeWord: session.wholeWord,
          includePatterns: parseGlobList(session.includePattern),
          excludePatterns: parseGlobList(session.excludePattern),
          includeIgnored: session.includeIgnored,
          contextLines: settings['search.contextLines'],
          // Always `null` (no filter), deliberately: an earlier version sent
          // `isUnity ? ['cs'] : null`, which made shaders, `.asmdef`,
          // `.uxml`, and Unity's YAML assets (scenes, prefabs, materials)
          // unsearchable in a Unity project — exactly the files someone
          // debugging a Unity project is often looking for.
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
        // Must not survive a clear: otherwise re-typing the exact same query
        // later would look "already searched" to the auto-search gate and
        // silently skip a search that never actually ran.
        searchedSignature: null,
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
