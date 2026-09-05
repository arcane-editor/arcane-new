import { describe, it, expect } from 'bun:test';
import {
  MAX_ZOOM,
  MIN_VISIBLE,
  MIN_ZOOM,
  ZOOM_STEP_BASE,
  clampViewport,
  clampZoom,
  fitViewport,
  isFitted,
  panBy,
  stepZoom,
  wheelZoomFactor,
  worldAt,
  zoomAt,
} from './viewport';

const SCREEN = { width: 1920, height: 1080 };

describe('clampZoom', () => {
  it('leaves an in-range zoom alone', () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(0.5)).toBe(0.5);
  });

  it('clamps past either bound', () => {
    expect(clampZoom(MAX_ZOOM * 4)).toBe(MAX_ZOOM);
    expect(clampZoom(MIN_ZOOM / 4)).toBe(MIN_ZOOM);
  });

  /**
   * A zero or negative zoom is not hypothetical: it is what a fit against a
   * zero-height container computes. It reaches the stage as `scale(0)`, and
   * the selection chrome divides by it — so `calc(1px / 0)` invalidates the
   * whole rule and the selection outline silently disappears.
   */
  it('resolves anything non-positive or non-numeric to the floor', () => {
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(-2)).toBe(MIN_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(MIN_ZOOM);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(MAX_ZOOM);
    expect(clampZoom(undefined as unknown as number)).toBe(MIN_ZOOM);
  });
});

describe('fitViewport', () => {
  it('fits the constrained axis and centres on both', () => {
    // A 16:9 document in a wide container: height is the binding axis.
    const vp = fitViewport(SCREEN, { width: 1600, height: 540 }, 0);
    expect(vp.zoom).toBeCloseTo(0.5, 10);
    expect(vp.y).toBeCloseTo(0, 10);
    // 1920 * 0.5 = 960 wide, in 1600 => 320 either side.
    expect(vp.x).toBeCloseTo(320, 10);
  });

  it('fits width when width is the binding axis', () => {
    const vp = fitViewport(SCREEN, { width: 960, height: 2000 }, 0);
    expect(vp.zoom).toBeCloseTo(0.5, 10);
    expect(vp.x).toBeCloseTo(0, 10);
    expect(vp.y).toBeCloseTo((2000 - 540) / 2, 10);
  });

  it('discounts padding on both axes', () => {
    const vp = fitViewport(SCREEN, { width: 1000, height: 1000 }, 20);
    // Available width is 960, so the fit is 960/1920.
    expect(vp.zoom).toBeCloseTo(0.5, 10);
    // Centring is against the FULL container, so the padding stays even.
    expect(vp.x).toBeCloseTo(20, 10);
  });

  /**
   * The first render happens before the ResizeObserver has measured anything,
   * so a zero container is on the normal path rather than a corner case.
   */
  it('survives a container or content of zero size', () => {
    expect(fitViewport(SCREEN, { width: 0, height: 0 }, 20).zoom).toBe(1);
    expect(fitViewport({ width: 0, height: 0 }, { width: 800, height: 600 }, 0).zoom).toBe(1);
  });

  it('never fits past the zoom ceiling', () => {
    const vp = fitViewport({ width: 10, height: 10 }, { width: 4000, height: 4000 }, 0);
    expect(vp.zoom).toBe(MAX_ZOOM);
  });
});

describe('zoomAt', () => {
  /**
   * The whole point of anchored zoom: the pixel under the cursor is the one
   * that must not move. Everything else in the canvas is allowed to.
   */
  it('keeps the world point under the anchor fixed', () => {
    const vp = { x: 100, y: 50, zoom: 0.5 };
    const anchor = { x: 640, y: 360 };
    const before = worldAt(vp, anchor);
    const after = worldAt(zoomAt(vp, 2, anchor), anchor);
    expect(after.x).toBeCloseTo(before.x, 8);
    expect(after.y).toBeCloseTo(before.y, 8);
  });

  it('still anchors when the requested zoom is clamped', () => {
    const vp = { x: 100, y: 50, zoom: 0.5 };
    const anchor = { x: 200, y: 200 };
    const zoomed = zoomAt(vp, MAX_ZOOM * 10, anchor);
    expect(zoomed.zoom).toBe(MAX_ZOOM);
    const before = worldAt(vp, anchor);
    const after = worldAt(zoomed, anchor);
    expect(after.x).toBeCloseTo(before.x, 8);
    expect(after.y).toBeCloseTo(before.y, 8);
  });

  it('leaves the viewport alone for a non-finite anchor', () => {
    const vp = { x: 100, y: 50, zoom: 0.5 };
    expect(zoomAt(vp, 2, { x: Number.NaN, y: 0 })).toEqual(vp);
  });
});

describe('stepZoom', () => {
  it('moves one geometric step per press in each direction', () => {
    const vp = { x: 0, y: 0, zoom: 1 };
    const anchor = { x: 0, y: 0 };
    expect(stepZoom(vp, 1, anchor).zoom).toBeCloseTo(ZOOM_STEP_BASE, 10);
    expect(stepZoom(vp, -1, anchor).zoom).toBeCloseTo(1 / ZOOM_STEP_BASE, 10);
  });

  /**
   * Held-down zoom-out must not bank invisible steps past the floor, or the
   * first zoom-in afterwards appears to do nothing. Same reasoning as
   * `app-shell/zoom.ts`, which clamps for the same reason.
   */
  it('does not bank steps past a bound', () => {
    const anchor = { x: 0, y: 0 };
    let vp = { x: 0, y: 0, zoom: MIN_ZOOM };
    for (let i = 0; i < 20; i++) vp = stepZoom(vp, -1, anchor);
    expect(vp.zoom).toBe(MIN_ZOOM);
    expect(stepZoom(vp, 1, anchor).zoom).toBeCloseTo(MIN_ZOOM * ZOOM_STEP_BASE, 10);
  });

  it('returns to where it started after equal steps in and out', () => {
    const anchor = { x: 300, y: 200 };
    const start = { x: 12, y: 34, zoom: 0.75 };
    const back = stepZoom(stepZoom(start, 1, anchor), -1, anchor);
    expect(back.zoom).toBeCloseTo(start.zoom, 8);
    expect(back.x).toBeCloseTo(start.x, 8);
    expect(back.y).toBeCloseTo(start.y, 8);
  });
});

describe('panBy', () => {
  it('translates without touching the zoom', () => {
    expect(panBy({ x: 10, y: 20, zoom: 0.5 }, 5, -7)).toEqual({ x: 15, y: 13, zoom: 0.5 });
  });

  /**
   * Per axis, not per call: a NaN on one axis is dropped while the other still
   * moves. A viewport that has taken a NaN is unrecoverable — every later
   * clamp and zoom propagates it — so the bad component never lands.
   */
  it('drops a non-finite delta on one axis without stalling the other', () => {
    const vp = { x: 10, y: 20, zoom: 0.5 };
    expect(panBy(vp, Number.NaN, 5)).toEqual({ x: 10, y: 25, zoom: 0.5 });
    expect(panBy(vp, 5, Number.POSITIVE_INFINITY)).toEqual({ x: 15, y: 20, zoom: 0.5 });
  });
});

describe('clampViewport', () => {
  const container = { width: 800, height: 600 };

  it('leaves a fitted viewport untouched', () => {
    const fit = fitViewport(SCREEN, container, 20);
    expect(clampViewport(fit, SCREEN, container)).toEqual(fit);
  });

  /**
   * The failure this prevents is the one with no recovery from the mouse: pan
   * the stage far enough and there is nothing left on screen to grab or to
   * aim a cursor-anchored zoom at.
   */
  it('always leaves a sliver of the stage on screen, in every direction', () => {
    const scaled = { width: SCREEN.width * 0.5, height: SCREEN.height * 0.5 };
    for (const [dx, dy] of [
      [100000, 0],
      [-100000, 0],
      [0, 100000],
      [0, -100000],
      [-100000, -100000],
    ]) {
      const vp = clampViewport(panBy({ x: 0, y: 0, zoom: 0.5 }, dx, dy), SCREEN, container);
      expect(vp.x).toBeLessThanOrEqual(container.width - MIN_VISIBLE);
      expect(vp.x + scaled.width).toBeGreaterThanOrEqual(MIN_VISIBLE);
      expect(vp.y).toBeLessThanOrEqual(container.height - MIN_VISIBLE);
      expect(vp.y + scaled.height).toBeGreaterThanOrEqual(MIN_VISIBLE);
    }
  });

  it('keeps a stage smaller than the sliver wholly on screen', () => {
    const tiny = { width: 20, height: 20 };
    const vp = clampViewport({ x: -500, y: -500, zoom: 1 }, tiny, container);
    expect(vp.x).toBe(0);
    expect(vp.y).toBe(0);
  });

  /**
   * Zoomed in, most of the stage is legitimately off-screen — that is what
   * zooming in means. The clamp must not drag it back to the container.
   */
  it('lets a stage far larger than the container pan across its whole span', () => {
    // 1920 * 4 = 7680 wide, so the left edge may run to -(7680 - MIN_VISIBLE).
    const span = -(SCREEN.width * 4 - MIN_VISIBLE);
    expect(clampViewport({ x: -4000, y: 0, zoom: 4 }, SCREEN, container).x).toBe(-4000);
    expect(clampViewport({ x: span, y: 0, zoom: 4 }, SCREEN, container).x).toBe(span);
    expect(clampViewport({ x: span - 1, y: 0, zoom: 4 }, SCREEN, container).x).toBe(span);
  });
});

describe('wheelZoomFactor', () => {
  it('zooms in for a negative delta and out for a positive one', () => {
    expect(wheelZoomFactor(-50)).toBeGreaterThan(1);
    expect(wheelZoomFactor(50)).toBeLessThan(1);
    expect(wheelZoomFactor(0)).toBe(1);
  });

  it('is symmetric, so a wheel back undoes a wheel forward', () => {
    expect(wheelZoomFactor(-40) * wheelZoomFactor(40)).toBeCloseTo(1, 10);
  });

  /**
   * A single high-resolution wheel notch can report a delta in the hundreds,
   * and some mice report thousands. Unclamped, one notch jumps several zoom
   * levels and the canvas appears to teleport.
   */
  it('caps a single event so one notch cannot teleport the canvas', () => {
    expect(wheelZoomFactor(-100000)).toBe(wheelZoomFactor(-1000));
    expect(wheelZoomFactor(100000)).toBe(wheelZoomFactor(1000));
  });

  it('treats a non-finite delta as no zoom', () => {
    expect(wheelZoomFactor(Number.NaN)).toBe(1);
  });
});

describe('isFitted', () => {
  it('is true for the fit itself and false once moved', () => {
    const fit = fitViewport(SCREEN, { width: 800, height: 600 }, 20);
    expect(isFitted(fit, fit)).toBe(true);
    expect(isFitted(panBy(fit, 40, 0), fit)).toBe(false);
    expect(isFitted({ ...fit, zoom: fit.zoom * 1.5 }, fit)).toBe(false);
  });

  /**
   * Fit is recomputed on every container resize, so the value compared against
   * is a fresh float each time. An exact equality check would leave the Fit
   * button unlit while the view is, visibly, fitted.
   */
  it('tolerates sub-pixel drift from a recomputed fit', () => {
    const fit = fitViewport(SCREEN, { width: 800, height: 600 }, 20);
    expect(isFitted({ ...fit, x: fit.x + 0.0001, zoom: fit.zoom * 1.000001 }, fit)).toBe(true);
  });
});
