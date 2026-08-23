/**
 * Converting a Tauri drag-drop position into CSS pixels.
 *
 * Tauri hands native OS file drops a `PhysicalPosition`, while
 * `getBoundingClientRect()` is in CSS pixels. On a Retina display those differ
 * by 2x, so skipping this conversion puts every drop in the wrong quadrant of
 * the window — a bug each drop zone otherwise has to rediscover.
 *
 * It lives in `utils/` rather than in any one feature because three separate
 * drop zones need it (the terminal, the explorer tree and the AI panel) and it
 * had already been copied once. `devicePixelRatio` is a parameter rather than
 * read from `window` so this stays pure and testable without a DOM.
 */
export function toCssPoint(
  position: { x: number; y: number },
  devicePixelRatio: number,
): { x: number; y: number } {
  const dpr = devicePixelRatio || 1;
  return { x: position.x / dpr, y: position.y / dpr };
}

/** True when a CSS-pixel point falls inside a rect that is actually on screen. */
export function rectContains(
  rect: { left: number; right: number; top: number; bottom: number; width: number; height: number },
  x: number,
  y: number,
): boolean {
  // A zero-size rect is an element in a collapsed panel: it exists in the DOM
  // and must never win a hit-test.
  if (rect.width === 0 || rect.height === 0) return false;
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}
