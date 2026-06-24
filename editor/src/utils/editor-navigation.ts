export interface EditorNavigationTarget {
  line: number;
  column: number;
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
