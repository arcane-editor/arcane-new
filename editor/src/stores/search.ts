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
  searchSignature,
  unityNoiseExcludes,
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
  /** Saves every file session `id` has edited (`editedPaths`), leaving any
   *  path whose save failed in the list — see the doc comment on the
   *  implementation below. */
  saveAllEdited: (id: string) => Promise<void>;
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

    // Read before the signature is stamped, not after: `search()` reads
    // BOTH of these fresh from the settings store on every call
    // (`resolveCaseSensitive`'s third argument below, and the `contextLines`
    // backend option), so the signature must be computed from the SAME
    // settings values this call is actually about to use — not from
    // whatever the settings store holds later, after `ensureListeners()`
    // and other awaits have had a chance to run.
    const settings = useSettingsStore.getState().settings;

    const gen = ++searchGeneration;
    // Previous results stay visible until the first batch replaces them.
    // `activeExcerptId` is cleared here too: it names an excerpt from the
    // PREVIOUS result set by id (`path:startLine`), and a new search can
    // produce an excerpt that reuses one of those ids for entirely different
    // content (same file, same start line, different surrounding matches) —
    // without this, `active` would point at an excerpt that no longer
    // exists.
    set((s) => ({
      sessions: patchSession(s.sessions, id, {
        isSearching: true,
        activeSearchId: gen,
        receivedFirstBatch: false,
        searchError: null,
        activeExcerptId: null,
        // Stamped from the pre-invoke `session` snapshot AND the settings
        // read above — the same query/option/settings values
        // `SearchQueryBar`'s auto-search effect will compare its own
        // freshly computed signature against on a later remount.
        searchedSignature: searchSignature({
          query: session.query,
          isRegex: session.isRegex,
          caseSensitive: session.caseSensitive,
          wholeWord: session.wholeWord,
          includeIgnored: session.includeIgnored,
          includePattern: session.includePattern,
          excludePattern: session.excludePattern,
          useSmartcase: settings['search.useSmartcase'],
          contextLines: settings['search.contextLines'],
          includeUnityAssets: session.includeUnityAssets,
        }),
      }),
    }));

    try {
      // Must be attached before the invoke resolves — batches can arrive as
      // soon as the backend spawns its worker thread.
      await ensureListeners();

      const isUnity = useProjectContextStore.getState().isUnityProject;
      const assetsRootPath = useWorkspaceStore.getState().assetsRootPath;
      const searchRoot = isUnity && assetsRootPath ? assetsRootPath : workspacePath;

      const caseSensitive = resolveCaseSensitive(
        session.query,
        session.caseSensitive,
        settings['search.useSmartcase'],
      );

      // Unity's YAML assets and .meta sidecars are excluded unless the tab
      // asks for them. Appended to the user's own excludes rather than sent as
      // `fileExtensions`, which the backend ANDs with the include glob — that
      // form cannot be widened by any pattern the user types.
      const excludePatterns = [
        ...parseGlobList(session.excludePattern),
        ...(isUnity && !session.includeUnityAssets ? unityNoiseExcludes() : []),
      ];

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
          excludePatterns,
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

  // Backs the `search-save-all` window event `App.tsx`'s `file.save` command
  // dispatches when `mod+s` fires while a results tab is active (there is no
  // single active file there to save). `get()` is read at CALL time, inside
  // this action — not by a caller who captured `editedPaths` earlier — so an
  // edit made after `ExcerptList`'s listener was registered is still picked
  // up: that listener is registered once per session id and lives for as
  // long as the tab does, well past any single edit.
  //
  // Fix round 1, Finding 1: the first version of this cleared `editedPaths`
  // unconditionally right after firing the saves, so a REJECTED save (disk
  // full, permissions, the file locked by Unity) still lost its place in the
  // list — the modified-count badge disappeared even though nothing was
  // written and the tab was still dirty. `Promise.allSettled` (not
  // `Promise.all`) is required, not just "await instead of void": one
  // unwritable file must not abort — or even delay past its own
  // rejection — the other saves in the batch. `saveFile` already shows its
  // own error toast and re-throws, so nothing here needs to surface a
  // message; it only needs to keep `editedPaths` honest. `allSettled` also
  // attaches its own reaction to every input promise, which is what stops a
  // rejected `saveFile()` from ALSO reaching `main.tsx`'s global
  // `unhandledrejection` handler and duplicating that toast — the earlier
  // `void saveFile(path)` (no `.catch`, nothing awaiting it) left each
  // rejection with no handler at all.
  //
  // The write-back re-reads `sessions[id].editedPaths` from `get()` AGAIN,
  // after the awaits — not the `paths` snapshot taken before them — and
  // removes only the paths just confirmed saved. A path added mid-flight
  // (the user edits a different excerpt in this tab while these saves are
  // still in the air) is not in `succeeded`, so it survives untouched
  // instead of being clobbered by writing back a stale array.
  saveAllEdited: async (id) => {
    const paths = get().sessions[id]?.editedPaths ?? [];
    const results = await Promise.allSettled(
      paths.map((path) => useWorkspaceStore.getState().saveFile(path)),
    );
    const succeeded = new Set(
      paths.filter((_, i) => results[i]?.status === 'fulfilled'),
    );
    const current = get().sessions[id]?.editedPaths ?? [];
    get().update(id, { editedPaths: current.filter((p) => !succeeded.has(p)) });
  },
}));

export { DEFAULT_SESSION_ID };
