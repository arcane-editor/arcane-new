// Review-bar row label (T8) — pure helper that splits a pending review
// entry's absolute path into a basename (shown prominently) and a
// workspace-relative directory hint (muted secondary text), for
// `ReviewBar.tsx`'s per-file rows. Bun-testable in isolation, same spirit as
// `checkpoint-selection.ts`'s pure helpers.
//
// Relativization mirrors `humanize-tool-call.ts`'s `relativizePath` (case-
// tolerant workspace-root stripping, since macOS/Windows default to
// case-insensitive filesystems) but isn't imported from there: that module's
// helpers are unexported internals of a sibling component-support file, and
// `PendingReviewEntry.path` (edit-review's own key) is ALWAYS absolute — see
// `stores/edit-review.ts`'s header — unlike `humanizeToolCall`'s `args.path`,
// which is usually already workspace-relative. The two callers' inputs
// differ enough that duplicating the small check here beats reaching across
// a component-support module for it.

export interface ReviewRowLabel {
  name: string;
  /** Directory portion of the display path; '' when there's nothing to show (file sits at the workspace root). */
  dirHint: string;
}

function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p);
}

/**
 * Best-effort workspace-relative display path; falls back to the raw
 * (slash-normalized) path when `workspacePath` is unknown or doesn't
 * contain it.
 */
function displayPath(path: string, workspacePath?: string | null): string {
  const norm = path.replace(/\\/g, '/');
  if (!workspacePath || !isAbsolutePath(norm)) return norm;
  const root = (workspacePath.endsWith('/') ? workspacePath : `${workspacePath}/`).replace(/\\/g, '/');
  if (norm.toLowerCase().startsWith(root.toLowerCase())) return norm.slice(root.length);
  return norm;
}

export function formatReviewRowLabel(path: string, workspacePath?: string | null): ReviewRowLabel {
  const display = displayPath(path, workspacePath);
  const idx = display.lastIndexOf('/');
  if (idx === -1) return { name: display, dirHint: '' };
  return { name: display.slice(idx + 1), dirHint: display.slice(0, idx) };
}
