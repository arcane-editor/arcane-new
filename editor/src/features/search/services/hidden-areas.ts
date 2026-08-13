// `setHiddenAreas` is real on Monaco's CodeEditorWidget but absent from the
// published typings — it is how folding hides lines. It is the one internal
// API this feature depends on, so it lives behind this probe: if a future
// Monaco drops or renames it, blocks stay read-only and every other part of
// the search tab still works.

export interface LineRange {
  /** 1-based, inclusive. */
  start: number;
  /** 1-based, inclusive. */
  end: number;
}

interface HidableEditor {
  setHiddenAreas: (ranges: unknown[]) => void;
}

/**
 * The lines to HIDE, given the lines to show. Input ranges must be ascending
 * and non-overlapping — which is what `buildExcerpts` already guarantees,
 * since it merges overlapping and touching windows.
 */
export function complementRanges(visible: LineRange[], lineCount: number): LineRange[] {
  const hidden: LineRange[] = [];
  let cursor = 1;

  for (const range of visible) {
    if (range.start > cursor) {
      hidden.push({ start: cursor, end: range.start - 1 });
    }
    cursor = Math.max(cursor, range.end + 1);
  }
  if (cursor <= lineCount) {
    hidden.push({ start: cursor, end: lineCount });
  }
  return hidden;
}

export function canHideAreas(editor: unknown): editor is HidableEditor {
  return (
    typeof editor === 'object' &&
    editor !== null &&
    typeof (editor as HidableEditor).setHiddenAreas === 'function'
  );
}

/**
 * Hides everything outside `visible`. Returns false when the internal API is
 * unavailable, so the caller can fall back to the read-only render instead of
 * showing an editor with the whole file in it.
 */
export function applyHiddenAreas(
  editor: unknown,
  visible: LineRange[],
  lineCount: number,
): boolean {
  if (!canHideAreas(editor)) return false;
  editor.setHiddenAreas(
    complementRanges(visible, lineCount).map((range) => ({
      startLineNumber: range.start,
      startColumn: 1,
      endLineNumber: range.end,
      endColumn: 1,
    })),
  );
  return true;
}
