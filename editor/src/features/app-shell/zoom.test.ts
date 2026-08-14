import { describe, it, expect } from 'bun:test';
import {
  MAX_ZOOM_LEVEL,
  MIN_ZOOM_LEVEL,
  ZOOM_BASE,
  clampZoomLevel,
  nextZoomLevel,
  zoomFactorFor,
} from './zoom';

describe('clampZoomLevel', () => {
  it('leaves an in-range level alone', () => {
    expect(clampZoomLevel(0)).toBe(0);
    expect(clampZoomLevel(3)).toBe(3);
    expect(clampZoomLevel(-3)).toBe(-3);
  });

  it('clamps past either bound', () => {
    expect(clampZoomLevel(MAX_ZOOM_LEVEL + 5)).toBe(MAX_ZOOM_LEVEL);
    expect(clampZoomLevel(MIN_ZOOM_LEVEL - 5)).toBe(MIN_ZOOM_LEVEL);
  });

  /**
   * The level round-trips through the settings file, which is plain JSON on
   * disk that nothing validates on read. A NaN reaching `zoomFactorFor` would
   * be handed to the webview's setZoom as NaN and could leave the window at a
   * size no keystroke can undo — so garbage resolves to "no zoom", the one
   * value that is always recoverable.
   */
  it('resolves anything non-numeric to no zoom', () => {
    expect(clampZoomLevel(Number.NaN)).toBe(0);
    expect(clampZoomLevel(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampZoomLevel(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(clampZoomLevel(undefined as unknown as number)).toBe(0);
    expect(clampZoomLevel('4' as unknown as number)).toBe(0);
    expect(clampZoomLevel(null as unknown as number)).toBe(0);
  });
});

describe('zoomFactorFor', () => {
  it('is exactly 1 at level 0, so the default never scales anything', () => {
    expect(zoomFactorFor(0)).toBe(1);
  });

  it('grows by one base step per level up and shrinks per level down', () => {
    expect(zoomFactorFor(1)).toBeCloseTo(ZOOM_BASE, 10);
    expect(zoomFactorFor(2)).toBeCloseTo(ZOOM_BASE ** 2, 10);
    expect(zoomFactorFor(-1)).toBeCloseTo(1 / ZOOM_BASE, 10);
  });

  it('stays positive at the extremes, since a factor <= 0 is not renderable', () => {
    expect(zoomFactorFor(MIN_ZOOM_LEVEL)).toBeGreaterThan(0);
    expect(zoomFactorFor(MAX_ZOOM_LEVEL)).toBeGreaterThan(0);
  });

  it('clamps before scaling, so an out-of-range level cannot escape the bounds', () => {
    expect(zoomFactorFor(MAX_ZOOM_LEVEL + 10)).toBe(zoomFactorFor(MAX_ZOOM_LEVEL));
    expect(zoomFactorFor(Number.NaN)).toBe(1);
  });
});

describe('nextZoomLevel', () => {
  it('steps one level in either direction', () => {
    expect(nextZoomLevel(0, 1)).toBe(1);
    expect(nextZoomLevel(0, -1)).toBe(-1);
    expect(nextZoomLevel(2, -1)).toBe(1);
  });

  it('saturates at the bounds instead of running away', () => {
    expect(nextZoomLevel(MAX_ZOOM_LEVEL, 1)).toBe(MAX_ZOOM_LEVEL);
    expect(nextZoomLevel(MIN_ZOOM_LEVEL, -1)).toBe(MIN_ZOOM_LEVEL);
  });

  it('returns to the starting level when a step is undone', () => {
    expect(nextZoomLevel(nextZoomLevel(0, 1), -1)).toBe(0);
    expect(nextZoomLevel(nextZoomLevel(-2, -1), 1)).toBe(-2);
  });

  /**
   * Zoom-out held down at the floor must not bank up invisible negative
   * levels, or the first zoom-in press after it does nothing and the key
   * reads as broken.
   */
  it('does not bank up steps taken past a bound', () => {
    let level = 0;
    for (let i = 0; i < MIN_ZOOM_LEVEL * -1 + 5; i++) level = nextZoomLevel(level, -1);
    expect(level).toBe(MIN_ZOOM_LEVEL);
    expect(nextZoomLevel(level, 1)).toBe(MIN_ZOOM_LEVEL + 1);
  });

  it('recovers from a corrupt current level rather than propagating it', () => {
    expect(nextZoomLevel(Number.NaN, 1)).toBe(1);
  });
});
