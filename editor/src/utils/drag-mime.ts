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
