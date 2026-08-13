// Who is allowed to dispose a Monaco model the search tab is displaying.
//
// `features/editor/services/model-disposal.ts` documents the hazard this
// exists to avoid: a model that outlives its tab is an orphan, and a later
// project-wide LSP rename or quick-fix can find it via `findModelForUri`,
// apply an edit, see no open tab, and write the ENTIRE orphan buffer to disk —
// reverting the file to a version the user discarded and overwriting whatever
// Unity or git wrote in the meantime.
//
// Search creates models for files that have no tab, so it creates exactly such
// orphans. The rules:
//
//   - File already open in a tab  -> the TAB owns it. Search never claims it
//                                    and must never dispose it.
//   - Hydrated by search, unedited -> SEARCH owns it. Safe to dispose on LRU
//                                    eviction, on a new search, and on tab
//                                    close, because it cannot have unsaved
//                                    changes.
//   - Edited from the results tab  -> the tab opened by that first edit owns
//                                    it. Search TRANSFERS and stops tracking.

export class SearchModelRegistry {
  private owned = new Set<string>();

  /** Search created this model; it may dispose it later. */
  claim(path: string): void {
    this.owned.add(path);
  }

  /** Search owns this model right now. */
  owns(path: string): boolean {
    return this.owned.has(path);
  }

  /**
   * Give up a model. Returns true only if search owned it, i.e. only if the
   * caller may dispose it. A path search never claimed — a model backing an
   * open tab — always returns false.
   */
  release(path: string): boolean {
    return this.owned.delete(path);
  }

  /**
   * Hand ownership to a tab, WITHOUT authorising disposal. Called when a first
   * edit opens the file as a background tab: the model now holds unsaved
   * changes, and disposing it would discard them.
   */
  transfer(path: string): void {
    this.owned.delete(path);
  }

  /** Give up every model search still owns, returning them for disposal. */
  releaseAll(): string[] {
    const paths = [...this.owned];
    this.owned.clear();
    return paths;
  }
}
