// One search tab's complete state. Kept free of Zustand/Tauri so the
// reducers are directly bun-testable, exactly like search-model.ts.
import type { FileSearchResult } from '../../../types';
import type { StreamState } from './search-model';

export interface SearchOptionsState {
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  /** Search files excluded by .gitignore. Off matches the previous
   *  behaviour, where gitignored files were unsearchable with no override. */
  includeIgnored: boolean;
  includePattern: string;
  excludePattern: string;
  /** Search Unity's YAML assets (.unity/.prefab/.asset/…) and .meta sidecars.
   *  Off by default: in a Unity project they bury code hits under walls of
   *  serialized YAML. Only consulted for Unity projects. */
  includeUnityAssets: boolean;
}

export interface SearchSession extends StreamState, SearchOptionsState {
  /** Equals the owning tab's path, e.g. `search://1`. */
  id: string;
  query: string;
  searchError: string | null;
  /** Most-recent-first, capped at HISTORY_LIMIT by pushQuery (Task 6). */
  history: string[];
  /** -1 = the input holds a live (unsubmitted) query. */
  historyIndex: number;
  collapsedFiles: string[];
  /** Excerpt id -> extra context lines revealed above/below. */
  expanded: Record<string, { up: number; down: number }>;
  activeExcerptId: string | null;
  /** `searchSignature()` of the query+options combination this session last
   *  actually searched (or attempted to), `null` if it never has. Lets the
   *  query bar's auto-search effect tell an unchanged remount (switching
   *  tabs back) apart from a real edit — see `searchSignature`'s doc comment
   *  in `search-model.ts` for why that distinction matters. */
  searchedSignature: string | null;
}

export type SearchSessions = Record<string, SearchSession>;

export function createSession(id: string): SearchSession {
  return {
    id,
    query: '',
    isRegex: false,
    caseSensitive: false,
    wholeWord: false,
    includeIgnored: false,
    includePattern: '',
    excludePattern: '',
    includeUnityAssets: false,
    results: [] as FileSearchResult[],
    totalMatches: 0,
    fileCount: 0,
    truncated: false,
    isSearching: false,
    activeSearchId: null,
    receivedFirstBatch: false,
    searchError: null,
    history: [],
    historyIndex: -1,
    collapsedFiles: [],
    expanded: {},
    activeExcerptId: null,
    searchedSignature: null,
  };
}

/**
 * Immutably updates one session. Unknown id returns the SAME object by
 * reference so a zustand `setState` can skip the update entirely — the same
 * stale-event discipline `applyBatch` uses.
 */
export function patchSession(
  sessions: SearchSessions,
  id: string,
  patch: Partial<SearchSession>,
): SearchSessions {
  const existing = sessions[id];
  if (!existing) return sessions;
  return { ...sessions, [id]: { ...existing, ...patch } };
}

/**
 * Which session, if any, is currently tracking `searchId`. Streamed batches
 * carry only the backend id, so this is how an event finds its tab. `null`
 * means the run was superseded or cancelled and the event must be dropped.
 */
export function sessionForSearchId(
  sessions: SearchSessions,
  searchId: number,
): SearchSession | null {
  for (const session of Object.values(sessions)) {
    if (session.activeSearchId === searchId) return session;
  }
  return null;
}
