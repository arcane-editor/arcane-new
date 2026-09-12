/**
 * Wiring between the jump-history store and the two ways this app moves the
 * caret to somewhere else.
 *
 * 1. `setPendingNavigation` — the cross-file path. Callers set the target and
 *    then call `openFile`, so at the moment it fires `activeFilePath` is still
 *    the origin. Covers Go to Definition / Find All References
 *    (`lsp/services/providers.ts` `registerEditorOpener`), the palette's symbol
 *    mode, every search-result jump (`search/services/open-excerpt.ts`), AI file
 *    chips, and Unity's double-click-to-open.
 *
 * 2. `recordJumpOrigin()` called directly — the `navigate-to-line` path, whose
 *    callers `await openFile(...)` FIRST and only then dispatch the event. By
 *    then the origin is gone, so those three (Problems, Test tree, Call Stack)
 *    record it themselves before opening.
 *
 * KNOWN GAP: Monaco's own SAME-FILE Go to Definition goes through neither, so
 * it is not recorded. Capturing it means filtering `onDidChangeCursorPosition`
 * by `CursorChangeReason` in `EditorPanel`; deliberately not attempted here.
 */

import { useNavigationStore, type NavEntry } from '../stores/navigation';
import { useWorkspaceStore } from '../stores/workspace';
import { useUiStore } from '../stores/ui';
import { setPendingNavigation, setNavigationStartListener } from './editor-navigation';

function basename(path: string): string {
  return path.split('/').pop() || path;
}

/** Where the caret is right now, or null if no real file is focused. */
export function currentLocation(): NavEntry | null {
  const path = useWorkspaceStore.getState().activeFilePath;
  if (!path) return null;
  const cursor = useUiStore.getState().cursorPosition;
  return { path, line: cursor?.line ?? 1, column: cursor?.column ?? 1 };
}

/** Remember where we are, because we are about to leave. */
export function recordJumpOrigin(): void {
  const here = currentLocation();
  if (here) useNavigationStore.getState().push(here);
}

async function applyJump(target: NavEntry, from: NavEntry | null): Promise<void> {
  const nav = useNavigationStore.getState();
  nav.setReplaying(true);
  try {
    if (from && from.path === target.path) {
      // Same file: `openFile` would only re-activate an already-active tab, so
      // EditorPanel's `activeFilePath` effect never re-runs and a pending
      // target would sit unconsumed. The event path moves the caret directly.
      window.dispatchEvent(
        new CustomEvent('navigate-to-line', {
          detail: { line: target.line, column: target.column },
        }),
      );
      return;
    }
    setPendingNavigation({ line: target.line, column: target.column, highlight: true });
    await useWorkspaceStore.getState().openFile(target.path, basename(target.path));
  } finally {
    nav.setReplaying(false);
  }
}

export async function navigateBack(): Promise<void> {
  const here = currentLocation();
  const target = useNavigationStore.getState().goBack(here);
  if (target) await applyJump(target, here);
}

export async function navigateForward(): Promise<void> {
  const here = currentLocation();
  const target = useNavigationStore.getState().goForward(here);
  if (target) await applyJump(target, here);
}

export function canNavigateBack(): boolean {
  return useNavigationStore.getState().back.length > 0;
}

export function canNavigateForward(): boolean {
  return useNavigationStore.getState().forward.length > 0;
}

/** Register the `setPendingNavigation` hook. Idempotent; call once at startup. */
export function installJumpHistory(): void {
  setNavigationStartListener(recordJumpOrigin);
}
