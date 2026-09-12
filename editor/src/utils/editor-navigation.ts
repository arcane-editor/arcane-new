export interface EditorNavigationTarget {
  line: number;
  column: number;
  /**
   * Briefly highlight the destination line on arrival.
   *
   * Opt-in rather than always-on: a jump the user initiated from ANOTHER
   * surface (a binding, a reference list) is ambiguous on arrival and wants
   * confirming, whereas moving within a file the user is already reading does
   * not need the interruption.
   */
  highlight?: boolean;
}

let pendingNavigation: EditorNavigationTarget | null = null;

/**
 * Fires the instant a jump is queued, while `activeFilePath` still names the
 * ORIGIN — the caller sets the pending target and only then calls `openFile`.
 *
 * A callback rather than a direct store read because this module is imported
 * by `stores/` (see `stores/unity.ts`'s `unity-open-file` listener), so
 * reaching back into a store from here would close an import cycle.
 * `utils/jump-history.ts` installs the real implementation.
 */
type NavigationStartListener = () => void;
let onNavigationStart: NavigationStartListener | null = null;

export function setNavigationStartListener(fn: NavigationStartListener | null): void {
  onNavigationStart = fn;
}

export function getPendingNavigation(): EditorNavigationTarget | null {
  return pendingNavigation;
}

export function clearPendingNavigation(): void {
  pendingNavigation = null;
}

export function setPendingNavigation(nav: EditorNavigationTarget | null): void {
  // Only a real target is a jump; `clearPendingNavigation` routes here with
  // null once the target has been consumed, and that is not one.
  if (nav) onNavigationStart?.();
  pendingNavigation = nav;
}
