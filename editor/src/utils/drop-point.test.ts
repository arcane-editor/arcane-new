import { describe, it, expect } from 'bun:test';
import { rectContains, toCssPoint } from './drop-point';

describe('toCssPoint', () => {
  it('divides a physical position by the device pixel ratio', () => {
    expect(toCssPoint({ x: 200, y: 100 }, 2)).toEqual({ x: 100, y: 50 });
  });

  it('is a no-op at 1x', () => {
    expect(toCssPoint({ x: 200, y: 100 }, 1)).toEqual({ x: 200, y: 100 });
  });

  it('treats a missing or zero ratio as 1 rather than dividing by zero', () => {
    expect(toCssPoint({ x: 10, y: 20 }, 0)).toEqual({ x: 10, y: 20 });
  });
});

describe('rectContains', () => {
  const r = { left: 10, right: 110, top: 20, bottom: 220, width: 100, height: 200 };

  it('accepts a point inside, including the edges', () => {
    expect(rectContains(r, 50, 100)).toBe(true);
    expect(rectContains(r, 10, 20)).toBe(true);
    expect(rectContains(r, 110, 220)).toBe(true);
  });

  it('rejects a point outside', () => {
    expect(rectContains(r, 9, 100)).toBe(false);
    expect(rectContains(r, 50, 221)).toBe(false);
  });

  /** An element in a collapsed sidebar measures empty and must never win. */
  it('rejects every point in a zero-size rect', () => {
    const empty = { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
    expect(rectContains(empty, 0, 0)).toBe(false);
  });
});
