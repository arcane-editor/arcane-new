// Pure state-transition logic for the streaming content-search store
// (`src/stores/search.ts`). Kept free of Zustand/Tauri so it's directly
// bun-testable — see `search-model.test.ts` for the semantics this module
// documents and locks in.
//
// Backend contract (Task B2, `src-tauri/src/search.rs`):
//   - `start_content_search({ searchId, options })` — searchId is a frontend
//     monotonic counter; a newer id automatically supersedes/cancels any
//     older in-flight run.
//   - `cancel_content_search({ searchId })` — advances the backend's cursor
//     without starting a new run (pass an id strictly greater than the run
//     you want to stop).
//   - `search-results-batch` events stream `{ searchId, results }` as files
//     are matched.
//   - Exactly one `search-complete` event `{ searchId, totalMatches,
//     fileCount, truncated, cancelled, elapsedMs }` terminates a run,
//     `cancelled` distinguishing a superseded/stopped run from one that ran
//     to completion.

import type { FileSearchResult } from '../../../types';

/** The streaming-relevant slice of the search store's state. */
export interface StreamState {
  results: FileSearchResult[];
  totalMatches: number;
  fileCount: number;
  truncated: boolean;
  isSearching: boolean;
  /** The searchId the store currently cares about; events for any other id
   *  are stale and ignored. `null` means no search is being tracked. */
  activeSearchId: number | null;
  /** Whether at least one batch has been applied for `activeSearchId` yet.
   *  Gates the "first batch replaces, later batches append" rule. */
  receivedFirstBatch: boolean;
}

export interface SearchBatchPayload {
  searchId: number;
  results: FileSearchResult[];
}

export interface SearchCompletePayload {
  searchId: number;
  totalMatches: number;
  fileCount: number;
  truncated: boolean;
  cancelled: boolean;
  elapsedMs: number;
}

/**
 * Parses a comma-separated glob-pattern field (the include/exclude filter
 * inputs) into a list of trimmed, non-empty patterns. `''`, whitespace-only,
 * and comma-only input all yield `[]`. Does not deduplicate.
 */
export function parseGlobList(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Applies one `search-results-batch` event to the stream state.
 *
 * - Stale id (`payload.searchId !== state.activeSearchId`): no-op, returns
 *   `state` unchanged (by reference, so callers can skip a store update).
 * - First batch for the active id: REPLACES `results` (D4 — the previous
 *   search's results are left visible in `state.results` up to this point,
 *   and must be discarded rather than merged with the new run's matches).
 * - Any later batch for the active id: APPENDS to `results`.
 */
export function applyBatch(state: StreamState, payload: SearchBatchPayload): StreamState {
  if (payload.searchId !== state.activeSearchId) {
    return state;
  }

  if (!state.receivedFirstBatch) {
    return {
      ...state,
      results: payload.results,
      receivedFirstBatch: true,
    };
  }

  return {
    ...state,
    results: [...state.results, ...payload.results],
  };
}

/**
 * Applies a `search-complete` event to the stream state.
 *
 * - Stale id: no-op, returns `state` unchanged by reference. This is the
 *   normal path for a cancelled/superseded run's completion — whichever
 *   action caused the cancellation (a new `search()` call bumping
 *   `activeSearchId`, or `clearResults()` clearing it) has already moved
 *   `state.activeSearchId` off of `payload.searchId` by the time this event
 *   round-trips back, so it's caught here without needing to inspect
 *   `payload.cancelled` at all.
 * - Active id, `cancelled: true` (defense-in-depth): in the store's normal
 *   flow this should not be reachable — see above — but if it is, only
 *   `isSearching` is cleared. `results`/totals are left untouched: whatever
 *   caller cancelled the still-active run (not a superseding search, which
 *   would have changed `activeSearchId`) already owns deciding the final
 *   displayed state, and a cancelled run's totals are a partial/incomplete
 *   count that must not overwrite it.
 * - Active id, successful (non-cancelled) completion: clears `isSearching`
 *   and carries `totalMatches`/`fileCount`/`truncated` from the payload.
 *   `results` become `[]` if zero batches were ever received (a genuine
 *   zero-match search), otherwise the accumulated batch results are kept
 *   as-is.
 */
export function applyComplete(state: StreamState, payload: SearchCompletePayload): StreamState {
  if (payload.searchId !== state.activeSearchId) {
    return state;
  }

  if (payload.cancelled) {
    return { ...state, isSearching: false };
  }

  return {
    ...state,
    isSearching: false,
    totalMatches: payload.totalMatches,
    fileCount: payload.fileCount,
    truncated: payload.truncated,
    results: state.receivedFirstBatch ? state.results : [],
  };
}

/**
 * Shortest debounced query that triggers an automatic search. Below this a
 * query matches so much of a workspace that the scan is pure cost.
 */
export const MIN_AUTO_SEARCH_CHARS = 3;

/** What the panel's auto-search effect should do for a settled query. */
export type AutoSearchAction = 'search' | 'clear' | 'idle';

/**
 * Decides the auto-search effect's behaviour from the DEBOUNCED query alone.
 *
 * Deliberately a function of one settled value, because the bug this replaces
 * came from the effect depending on more than that: `triggerSearch` closes
 * over the *live* query, so it was a new function identity on every keystroke,
 * and listing it as a dependency re-ran the effect per character. The guard
 * inside (`length >= MIN_AUTO_SEARCH_CHARS`) stays true once the user has
 * typed that many characters, so every subsequent keystroke started a fresh
 * search — each one a Rust thread walking the entire workspace, all racing
 * results into the same list. The 300ms debounce was still running; it just
 * no longer gated anything.
 *
 * `'idle'` (short but non-empty) is a distinct outcome on purpose: clearing
 * there would wipe results the user is still reading while they finish typing.
 */
export function autoSearchAction(debouncedQuery: string): AutoSearchAction {
  if (debouncedQuery.length >= MIN_AUTO_SEARCH_CHARS) return 'search';
  if (debouncedQuery.length === 0) return 'clear';
  return 'idle';
}
