/**
 * The Recent Files MRU — paths the user has visited, most recent first.
 *
 * Its own module, not a helper inside `workspace.ts`, so it can be tested
 * without mocking the Tauri boundary: importing the workspace store for real
 * needs a whole separate process (see `search-tab-lifecycle.exec.ts`), which is
 * far too much machinery for a list operation.
 *
 * Distinct from the two neighbouring lists it is easy to confuse it with:
 *   - `openFiles` is tab-bar order, and loses an entry when a tab closes;
 *   - `recentlyClosed` is a LIFO undo stack for Reopen Closed Tab.
 * This one outlives the tab, which is the whole point of a recents list.
 */

import { isVirtualPath } from '../utils/virtual-path';

/** How many visited files the switcher remembers. */
export const RECENT_FILES_LIMIT = 50;

/**
 * Move-to-front MRU update.
 *
 * Returns `list` itself (same reference) when there is nothing to record, so
 * the caller can skip a pointless state write — and, since it drives a store
 * subscription, avoid a re-render loop.
 */
export function pushRecentFile(list: string[], path: string): string[] {
  if (!path || isVirtualPath(path)) return list;
  return [path, ...list.filter((p) => p !== path)].slice(0, RECENT_FILES_LIMIT);
}
