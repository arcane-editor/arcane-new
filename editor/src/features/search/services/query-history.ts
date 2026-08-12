/** Matches Zed's BufferSearchBar, which keeps up to 50 previous queries. */
export const HISTORY_LIMIT = 50;

export function pushQuery(history: string[], query: string): string[] {
  if (!query.trim()) return history;
  return [query, ...history.filter((entry) => entry !== query)].slice(0, HISTORY_LIMIT);
}

export interface HistoryPosition {
  /** -1 means the input is back on the live, unsubmitted query. */
  index: number;
  query: string;
}

/**
 * Moves through the history ring. `index` is the current position (-1 = live
 * query); `back` walks toward older entries, `forward` toward newer and
 * finally back out to the live query. Returns `null` when there is nothing to
 * move to, so the caller can leave the input untouched.
 */
export function historyStep(
  history: string[],
  index: number,
  direction: 'back' | 'forward',
): HistoryPosition | null {
  if (history.length === 0) return null;

  if (direction === 'back') {
    const next = Math.min(index + 1, history.length - 1);
    return { index: next, query: history[next] };
  }

  const next = index - 1;
  if (next < 0) return { index: -1, query: '' };
  return { index: next, query: history[next] };
}

/**
 * Smartcase: an all-lowercase query searches case-insensitively, a query
 * containing an uppercase letter goes case-sensitive on its own. The explicit
 * `Aa` toggle always wins.
 */
export function resolveCaseSensitive(
  query: string,
  caseSensitive: boolean,
  useSmartcase: boolean,
): boolean {
  if (caseSensitive) return true;
  if (!useSmartcase) return false;
  return query !== query.toLowerCase();
}
