/**
 * Side-pane width arithmetic for the app shell's horizontal Allotment.
 *
 * Pure so the policy can be tested without a DOM — the same reason
 * `skip-shell.ts:52` is pure. This project has no component-test
 * infrastructure, so anything that must be verified is kept out of the React
 * wiring and lives here instead.
 *
 * Pane order in the horizontal group is fixed: [sidebar, editor, rightPanel].
 * All three are permanently mounted and toggled via Allotment's `visible`
 * prop, so the indices are stable regardless of what is currently shown.
 */

/** Fraction of the window each side pane gets on first open. */
export const DEFAULT_SIDE_FRACTION = 0.3;

/**
 * Largest fraction of the window a *persisted* side width may claim.
 *
 * This exists to discard leftovers from a bad layout, not to overrule the
 * user. It was 0.45, which silently snapped any deliberately wide sidebar back
 * to DEFAULT_SIDE_FRACTION on the next launch — the layout looked forgotten
 * because it was.
 */
export const MAX_SIDE_FRACTION = 0.8;

/** The editor never shrinks below this, however wide the side panes get. */
export const MIN_EDITOR_WIDTH = 320;

/** Index of the editor pane in the horizontal group. */
export const EDITOR_PANE_INDEX = 1;

/**
 * A persisted side-pane width, or the fallback fraction when the stored value
 * is missing, malformed, or implausible.
 */
export function resolveSideWidth(
  persisted: number | undefined,
  windowWidth: number,
  fallbackFraction: number,
): number {
  if (
    typeof persisted !== 'number' ||
    !Number.isFinite(persisted) ||
    persisted <= 0 ||
    persisted > windowWidth * MAX_SIDE_FRACTION
  ) {
    return Math.round(windowWidth * fallbackFraction);
  }
  return Math.round(persisted);
}

/**
 * Pane sizes for the initial mount, as absolute px.
 *
 * Allotment scales `defaultSizes` to fit, and wants one entry per
 * always-mounted pane.
 */
export function initialPaneSizes(
  persisted: { sidebar?: number; rightPanel?: number },
  windowWidth: number,
): { left: number; right: number; sizes: number[] } {
  const left = resolveSideWidth(persisted.sidebar, windowWidth, DEFAULT_SIDE_FRACTION);
  const right = resolveSideWidth(persisted.rightPanel, windowWidth, DEFAULT_SIDE_FRACTION);
  const editor = Math.max(windowWidth - left - right, MIN_EDITOR_WIDTH);
  return { left, right, sizes: [left, editor, right] };
}

/**
 * Sizes to hand `AllotmentHandle.resize` so `paneIndex` reopens at `width`.
 *
 * The editor absorbs the difference, matching the LayoutPriority.High it is
 * given in App.tsx — side panes hold their width and the editor takes the
 * delta. The total is pinned to the container width (the sum of `current`) so
 * the call cannot change the group's overall size.
 *
 * When the remembered width no longer fits — the window shrank, or the other
 * side pane grew while this one was hidden — the editor keeps `minEditorWidth`
 * and the reopening pane takes what is left.
 */
export function widthsForRestore(
  current: readonly number[],
  paneIndex: number,
  width: number,
  editorIndex: number,
  minEditorWidth: number,
): number[] {
  const total = current.reduce((sum, n) => sum + n, 0);
  const next = [...current];
  next[paneIndex] = Math.max(0, Math.round(width));

  const nonEditor = next.reduce((sum, n, i) => (i === editorIndex ? sum : sum + n), 0);
  const editor = total - nonEditor;

  if (editor >= minEditorWidth) {
    next[editorIndex] = editor;
    return next;
  }

  // Doesn't fit: the editor's floor wins and the reopening pane gives way.
  const otherPanes = nonEditor - next[paneIndex];
  next[editorIndex] = minEditorWidth;
  next[paneIndex] = Math.max(0, total - minEditorWidth - otherPanes);
  return next;
}
