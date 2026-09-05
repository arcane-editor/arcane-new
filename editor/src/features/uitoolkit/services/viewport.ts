/**
 * The preview canvas's camera.
 *
 * A `Viewport` maps the document's own coordinate space — WORLD space, where
 * `width: 420px` in USS is 420 units regardless of what the canvas is doing —
 * onto the screen:
 *
 *     screen = world * zoom + (x, y)
 *
 * so `(x, y)` is where the world origin lands in canvas pixels and `zoom` is
 * the only scale in the picture. That single number is also what reaches
 * `PreviewStage` as `--u-scale`, which is why every function here clamps it
 * to a positive, finite value: the selection chrome divides lengths by it, and
 * `calc(1px / 0)` invalidates the entire declaration rather than falling back
 * to something visible.
 *
 * Pure, and kept out of the React wiring for the same reason `app-shell/zoom.ts`
 * is: this project has no component-test infrastructure, so anything that has
 * to be verified lives where it can be called directly. The DOM half — wheel,
 * pointer and key handling — is `components/PreviewCanvas.tsx`.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Viewport {
  /** Where the world origin lands, in canvas pixels. */
  x: number;
  y: number;
  /** World-to-screen scale. Always finite and > 0. */
  zoom: number;
}

/**
 * Zoom bounds.
 *
 * The floor is low enough to frame a 4K-reference document whole in a narrow
 * side-by-side panel; the ceiling is past the point where a single USS pixel
 * fills a fifth of the canvas, which is far enough to inspect a border radius
 * and further than anything else is useful for.
 */
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 16;

/**
 * Proportional change per keyboard step. 1.2 matches `app-shell/zoom.ts`,
 * Chromium and VS Code, so a step feels the same size everywhere in the app.
 */
export const ZOOM_STEP_BASE = 1.2;

/**
 * How much of the stage a pan must always leave on screen.
 *
 * Without this the stage can be flung far enough that nothing remains to grab
 * or to aim a cursor-anchored zoom at — a state no mouse gesture recovers
 * from, only the Fit button.
 */
export const MIN_VISIBLE = 48;

/** Radians of zoom per pixel of wheel travel. */
const WHEEL_ZOOM_SENSITIVITY = 0.0015;

/** The largest single wheel delta honoured, before one notch starts teleporting. */
const MAX_WHEEL_DELTA = 1000;

function finite(n: number, fallback = 0): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/**
 * A zoom fit to divide by.
 *
 * Non-positive input is on the normal path, not a corner case: fitting against
 * a container that has not been measured yet computes exactly 0.
 */
export function clampZoom(zoom: number): number {
  if (typeof zoom !== 'number' || Number.isNaN(zoom)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** The world point currently under a canvas-space point. */
export function worldAt(vp: Viewport, screen: Point): Point {
  return { x: (screen.x - vp.x) / vp.zoom, y: (screen.y - vp.y) / vp.zoom };
}

/**
 * The camera that centres `content` in `container` at the largest scale that
 * fits, with `padding` canvas pixels held clear on every side.
 *
 * Centring is computed against the FULL container rather than the padded box,
 * so the slack stays even when only one axis binds.
 */
export function fitViewport(content: Size, container: Size, padding = 0): Viewport {
  const availWidth = container.width - padding * 2;
  const availHeight = container.height - padding * 2;
  if (
    !(availWidth > 0) ||
    !(availHeight > 0) ||
    !(content.width > 0) ||
    !(content.height > 0)
  ) {
    // Nothing measured yet. 1:1 at the origin is the one answer that is never
    // absurd, and the next resize will replace it.
    return { x: 0, y: 0, zoom: 1 };
  }
  const zoom = clampZoom(Math.min(availWidth / content.width, availHeight / content.height));
  return {
    x: (container.width - content.width * zoom) / 2,
    y: (container.height - content.height * zoom) / 2,
    zoom,
  };
}

/**
 * Re-scale about a fixed canvas point — the pixel under the cursor stays under
 * the cursor.
 *
 * The world point is read BEFORE clamping and re-projected with the clamped
 * zoom, so a gesture that runs into a zoom bound stops scaling without also
 * drifting sideways.
 */
export function zoomAt(vp: Viewport, nextZoom: number, anchor: Point): Viewport {
  if (!Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) return vp;
  const zoom = clampZoom(nextZoom);
  const world = worldAt(vp, anchor);
  return { x: anchor.x - world.x * zoom, y: anchor.y - world.y * zoom, zoom };
}

/**
 * `steps` geometric steps in (positive) or out (negative), about `anchor`.
 *
 * Clamped by `zoomAt`, so holding zoom-out at the floor banks nothing and the
 * next zoom-in is immediately visible.
 */
export function stepZoom(vp: Viewport, steps: number, anchor: Point): Viewport {
  return zoomAt(vp, vp.zoom * ZOOM_STEP_BASE ** finite(steps), anchor);
}

/** Translate the camera. A non-finite delta is dropped rather than propagated. */
export function panBy(vp: Viewport, dx: number, dy: number): Viewport {
  return { ...vp, x: vp.x + finite(dx), y: vp.y + finite(dy) };
}

/**
 * The scale change one wheel event asks for.
 *
 * Exponential rather than linear so the gesture feels the same at 20% as at
 * 400%, and symmetric so wheeling back undoes wheeling forward exactly. The
 * delta is capped because a single high-resolution notch can report a value in
 * the hundreds and some mice report thousands — unclamped, one notch crosses
 * several zoom levels and the canvas appears to teleport.
 */
export function wheelZoomFactor(deltaY: number): number {
  const clamped = Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, finite(deltaY)));
  return Math.exp(-clamped * WHEEL_ZOOM_SENSITIVITY);
}

/**
 * Pull a camera back until the stage overlaps the canvas by `MIN_VISIBLE` on
 * each axis — or, for a stage smaller than that, until it is wholly on screen.
 */
export function clampViewport(vp: Viewport, content: Size, container: Size): Viewport {
  const clampAxis = (pos: number, extent: number, viewExtent: number) => {
    const visible = Math.min(MIN_VISIBLE, extent);
    const min = -(extent - visible);
    const max = viewExtent - visible;
    // A container narrower than the sliver inverts the bounds; pinning to the
    // near edge keeps the stage on screen rather than snapping it off one.
    const next = min > max ? Math.min(0, max) : Math.min(max, Math.max(min, pos));
    // A stage exactly as wide as the sliver computes a bound of `-0`, which
    // survives arithmetic all the way into a `translate(-0px, ...)` string.
    return next === 0 ? 0 : next;
  };
  return {
    ...vp,
    x: clampAxis(vp.x, content.width * vp.zoom, container.width),
    y: clampAxis(vp.y, content.height * vp.zoom, container.height),
  };
}

/**
 * Whether the camera is still sitting at `fit` — what lights the Fit button.
 *
 * Compared with a tolerance because `fit` is recomputed from container floats
 * on every resize; exact equality would leave the button unlit while the view
 * is visibly fitted. Zoom is compared proportionally, since an absolute
 * epsilon means something very different at 0.05 than at 16.
 */
export function isFitted(vp: Viewport, fit: Viewport): boolean {
  return (
    Math.abs(vp.zoom - fit.zoom) <= fit.zoom * 1e-3 &&
    Math.abs(vp.x - fit.x) <= 0.5 &&
    Math.abs(vp.y - fit.y) <= 0.5
  );
}
