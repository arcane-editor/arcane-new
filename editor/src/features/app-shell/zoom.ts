/**
 * Window zoom arithmetic, in VS Code's units.
 *
 * Zoom is stored as a *level* (an integer around 0), not a scale factor, so
 * that stepping is uniform: every press of Cmd+= is one level, and one level
 * is always the same proportional change whether you are zoomed in or out.
 * Storing a factor instead would make a fixed +0.1 step feel huge at 0.3x and
 * negligible at 4x. `ZOOM_BASE ** level` converts to the factor the webview
 * wants.
 *
 * Pure so the policy can be tested without a DOM or a webview, for the same
 * reason `skip-shell.ts` and `layout-sizes.ts` are — this project has no
 * component-test infrastructure, so anything that must be verified is kept out
 * of the React wiring. The actual `setZoom` call lives in
 * `services/zoom-apply.ts`.
 */

/** Proportional change per level. VS Code and Chromium both use 1.2. */
export const ZOOM_BASE = 1.2;

/**
 * Bounds, matching VS Code's. At the edges the UI is ~0.23x and ~4.3x, which
 * is already past the point of usefulness in both directions; going further
 * mainly produces states a user cannot read well enough to escape from.
 */
export const MIN_ZOOM_LEVEL = -8;
export const MAX_ZOOM_LEVEL = 8;

/**
 * A level fit to use, given anything at all.
 *
 * Non-numeric input is not hypothetical: the level round-trips through the
 * settings JSON on disk, which nothing validates on read. Resolving garbage to
 * 0 rather than propagating it keeps a corrupt settings file from opening the
 * window at an unreadable scale — the one failure a keyboard shortcut could
 * not talk its way out of.
 */
export function clampZoomLevel(level: number): number {
  if (typeof level !== 'number' || !Number.isFinite(level)) return 0;
  return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, level));
}

/** The webview scale factor for a level. Exactly 1 at level 0. */
export function zoomFactorFor(level: number): number {
  const clamped = clampZoomLevel(level);
  return clamped === 0 ? 1 : ZOOM_BASE ** clamped;
}

/**
 * The level `delta` steps away from `current`, clamped.
 *
 * Clamping here rather than at apply-time is what stops held-down zoom-out
 * from banking invisible levels past the floor — otherwise the first zoom-in
 * press afterwards would spend a banked step and appear to do nothing.
 */
export function nextZoomLevel(current: number, delta: number): number {
  return clampZoomLevel(clampZoomLevel(current) + delta);
}
