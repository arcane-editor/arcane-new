/**
 * Keeps a cursor-anchored, `position: fixed` overlay (context menus, popups)
 * fully on screen.
 *
 * Menus opened at raw `clientX`/`clientY` render partly outside the window
 * whenever the cursor is near an edge — and because they're fixed-positioned,
 * the overflowing items can't be scrolled back into view, they're simply
 * unreachable. That bit hardest at the bottom of the file tree, where the
 * clipped items were Delete / Copy Path / Reveal.
 *
 * Preference order per axis: open at the cursor → flip to the other side of
 * the cursor (the native menu behaviour) → pin inside the margin.
 */

export interface ClampInput {
  /** Cursor position (viewport coordinates). */
  x: number;
  y: number;
  /** Measured overlay size. */
  width: number;
  height: number;
  /** Viewport size. */
  viewportWidth: number;
  viewportHeight: number;
  /** Minimum gap to keep from the viewport edge when pinning. */
  margin?: number;
}

export interface ClampResult {
  left: number;
  top: number;
}

function clampAxis(
  pos: number,
  size: number,
  viewport: number,
  margin: number,
): number {
  // Fits as-is.
  if (pos + size <= viewport - margin) return Math.max(margin, pos);
  // Flip to the other side of the cursor, if that fits.
  const flipped = pos - size;
  if (flipped >= margin) return flipped;
  // Neither side fits: pin inside the margin, never off the near edge.
  return Math.max(margin, viewport - size - margin);
}

export function clampToViewport({
  x,
  y,
  width,
  height,
  viewportWidth,
  viewportHeight,
  margin = 4,
}: ClampInput): ClampResult {
  return {
    left: clampAxis(x, width, viewportWidth, margin),
    top: clampAxis(y, height, viewportHeight, margin),
  };
}
