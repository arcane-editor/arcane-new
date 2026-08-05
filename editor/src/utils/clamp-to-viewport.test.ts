import { describe, it, expect } from 'bun:test';
import { clampToViewport } from './clamp-to-viewport';

const VIEWPORT = { viewportWidth: 1000, viewportHeight: 800 };

describe('clampToViewport', () => {
  it('leaves a menu that already fits untouched', () => {
    expect(clampToViewport({ x: 100, y: 100, width: 180, height: 200, ...VIEWPORT })).toEqual({
      left: 100,
      top: 100,
    });
  });

  // The explorer bug: right-clicking a file near the bottom of the tree put
  // Delete / Copy Path / Reveal below the viewport edge, unreachable — the
  // menu is position:fixed, so nothing scrolls them back into view.
  it('flips a menu up when it would overflow the bottom edge', () => {
    const { top } = clampToViewport({ x: 100, y: 700, width: 180, height: 240, ...VIEWPORT });
    expect(top).toBe(700 - 240); // opens upward from the cursor
    expect(top + 240).toBeLessThanOrEqual(VIEWPORT.viewportHeight);
  });

  // The tab-bar bug: right-clicking a tab far to the right pushed the menu
  // past the window edge.
  it('flips a menu left when it would overflow the right edge', () => {
    const { left } = clampToViewport({ x: 950, y: 100, width: 180, height: 200, ...VIEWPORT });
    expect(left).toBe(950 - 180);
    expect(left + 180).toBeLessThanOrEqual(VIEWPORT.viewportWidth);
  });

  it('clamps rather than flipping when flipping would overflow the opposite edge', () => {
    // Taller than the space above the cursor AND below it: pin to the margin.
    const { top } = clampToViewport({ x: 10, y: 100, width: 180, height: 780, ...VIEWPORT });
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top).toBe(VIEWPORT.viewportHeight - 780 - 4);
  });

  it('never returns a negative coordinate for a menu larger than the viewport', () => {
    const { left, top } = clampToViewport({
      x: 500,
      y: 400,
      width: 1200,
      height: 900,
      ...VIEWPORT,
    });
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
  });

  it('keeps a margin from the edge when clamping', () => {
    const { left } = clampToViewport({ x: 999, y: 10, width: 180, height: 100, ...VIEWPORT });
    expect(left + 180).toBeLessThanOrEqual(VIEWPORT.viewportWidth);
  });
});
