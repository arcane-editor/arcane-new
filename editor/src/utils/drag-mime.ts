/**
 * In-webview drag payload for workspace files.
 *
 * Used by the explorer tree and the tab bar to export a file, and by the AI
 * panel to accept one as context. Deliberately a custom MIME rather than
 * `text/plain`, so a drop zone can tell an intentional in-app drag from a
 * stray text selection — and so the tab bar's reorder drag (which carries its
 * own MIME) is never mistaken for a file drag, or vice versa.
 *
 * OS file drops do NOT arrive this way: Tauri intercepts those natively and
 * they surface through `onDragDropEvent` with a bare coordinate instead. See
 * `features/explorer/services/drop-target.ts`.
 */

export const ARCANE_FILE_MIME = 'application/x-arcane-file';

/**
 * The tab bar's own reorder payload — a bare absolute path.
 *
 * It lives here rather than privately in `TabBar` because a drop zone outside
 * the tab strip has to be able to READ it. The tab bar attaches this plus a
 * second `ARCANE_FILE_MIME` payload, and a zone that understood only the
 * second was one forgotten `setData` away from ignoring every tab drag while
 * explorer drags kept working — which is exactly how the two drifted apart.
 * One registry, both readers.
 */
export const EDITOR_TAB_MIME = 'application/x-editor-tab-path';

export interface ArcaneFileDrag {
  path: string;
  isDir: boolean;
}

export function serializeFileDrag(payload: ArcaneFileDrag): string {
  return JSON.stringify(payload);
}

/** Parses a drag payload, returning null for anything malformed. */
export function parseFileDrag(raw: string | null | undefined): ArcaneFileDrag | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { path, isDir } = parsed as Partial<ArcaneFileDrag>;
    if (typeof path !== 'string' || path.length === 0) return null;
    return { path, isDir: isDir === true };
  } catch {
    return null;
  }
}

/**
 * The file being dragged, from whichever payload the source attached.
 *
 * Prefers `ARCANE_FILE_MIME` (it carries `isDir`, which a bare path cannot),
 * and falls back to the tab-reorder payload so a tab drag identifies its file
 * even if the richer payload is missing.
 *
 * Takes the minimum shape it needs rather than a `DataTransfer`, so it is
 * testable without a DOM — the same reason `parseFileDrag` takes a string.
 */
export function readFileDrag(dataTransfer: {
  types: readonly string[];
  getData: (type: string) => string;
}): ArcaneFileDrag | null {
  if (dataTransfer.types.includes(ARCANE_FILE_MIME)) {
    const parsed = parseFileDrag(dataTransfer.getData(ARCANE_FILE_MIME));
    if (parsed) return parsed;
  }

  if (dataTransfer.types.includes(EDITOR_TAB_MIME)) {
    const path = dataTransfer.getData(EDITOR_TAB_MIME);
    // A virtual tab (`diff://`, `auth://`, `search://`) names no file on disk.
    // Checked by prefix rather than by importing `isVirtualPath`, because this
    // module is imported by the explorer, the tab bar and the AI panel, and it
    // stays dependency-free on purpose.
    if (path && !/^(diff|auth|search):\/\//.test(path)) {
      return { path, isDir: false };
    }
  }

  return null;
}

/** True when a drag carries a file this app can stage as context. */
export function hasFileDrag(types: readonly string[]): boolean {
  return types.includes(ARCANE_FILE_MIME) || types.includes(EDITOR_TAB_MIME);
}
