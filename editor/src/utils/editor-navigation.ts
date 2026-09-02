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

export function getPendingNavigation(): EditorNavigationTarget | null {
  return pendingNavigation;
}

export function clearPendingNavigation(): void {
  pendingNavigation = null;
}

export function setPendingNavigation(nav: EditorNavigationTarget | null): void {
  pendingNavigation = nav;
}
