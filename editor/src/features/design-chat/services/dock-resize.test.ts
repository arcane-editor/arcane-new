import { describe, it, expect } from 'bun:test';
import { applyDockDrag, clampDock, HANDLE_CURSOR, type DockHandle } from './dock-resize';
import { MIN_DOCK_WIDTH, MIN_DOCK_HEIGHT, type DockGeometry } from '../../../stores/design-chat';

const BOUNDS = { width: 1200, height: 800 };
const START: DockGeometry = { x: 300, bottom: 100, width: 560, height: 280 };

/** The dock's top edge, measured from the container's bottom — the invariant most edges must hold. */
function top(g: DockGeometry): number {
  return g.bottom + g.height;
}

describe('applyDockDrag — moving', () => {
  it('follows the pointer, inverting Y because `bottom` grows upward', () => {
    const next = applyDockDrag(START, 'move', 40, -30, BOUNDS);
    expect(next).toMatchObject({ x: 340, bottom: 130, width: 560, height: 280 });
  });

  it('always leaves enough of the dock on screen to grab it again', () => {
    const far = applyDockDrag(START, 'move', 5000, 0, BOUNDS);
    expect(far.x).toBeLessThanOrEqual(BOUNDS.width - 100);
    const left = applyDockDrag(START, 'move', -5000, 0, BOUNDS);
    expect(left.x + left.width).toBeGreaterThanOrEqual(100);
  });

  it('never pushes the dock below the floor or above the ceiling', () => {
    expect(applyDockDrag(START, 'move', 0, 5000, BOUNDS).bottom).toBe(0);
    expect(applyDockDrag(START, 'move', 0, -5000, BOUNDS).bottom).toBe(BOUNDS.height - START.height);
  });
});

describe('applyDockDrag — edges', () => {
  it('grows to the right from the east edge, leaving the left where it was', () => {
    const next = applyDockDrag(START, 'e', 100, 0, BOUNDS);
    expect(next).toMatchObject({ x: 300, width: 660 });
  });

  it('grows to the left from the west edge, leaving the RIGHT where it was', () => {
    const next = applyDockDrag(START, 'w', -100, 0, BOUNDS);
    expect(next.width).toBe(660);
    expect(next.x).toBe(200);
    expect(next.x + next.width).toBe(START.x + START.width);
  });

  it('grows upward from the north edge, leaving the bottom where it was', () => {
    const next = applyDockDrag(START, 'n', 0, -60, BOUNDS);
    expect(next).toMatchObject({ bottom: 100, height: 340 });
  });

  it('grows DOWNWARD from the south edge, leaving the top where it was', () => {
    // The counter-intuitive one: dragging the bottom edge down makes it taller.
    const next = applyDockDrag(START, 's', 0, 60, BOUNDS);
    expect(next.height).toBe(340);
    expect(next.bottom).toBe(40);
    expect(top(next)).toBe(top(START));
  });

  it('stops the south edge at the floor rather than pushing the dock through it', () => {
    const next = applyDockDrag(START, 's', 0, 5000, BOUNDS);
    expect(next.bottom).toBe(0);
    expect(top(next)).toBe(top(START));
  });
});

describe('applyDockDrag — corners', () => {
  it('applies both edges of a corner at once', () => {
    const next = applyDockDrag(START, 'ne', 100, -60, BOUNDS);
    expect(next).toMatchObject({ x: 300, bottom: 100, width: 660, height: 340 });
  });

  it('moves the origin for a south-west corner, and only the origin', () => {
    const next = applyDockDrag(START, 'sw', -100, 60, BOUNDS);
    expect(next.width).toBe(660);
    expect(next.x).toBe(200);
    expect(next.height).toBe(340);
    expect(top(next)).toBe(top(START));
  });
});

describe('applyDockDrag — floors', () => {
  it('never resizes below the minimum in either axis, from any edge', () => {
    for (const handle of ['e', 'w', 'n', 's', 'ne', 'nw', 'se', 'sw'] as DockHandle[]) {
      const next = applyDockDrag(START, handle, -5000, -5000, BOUNDS);
      expect(next.width).toBeGreaterThanOrEqual(MIN_DOCK_WIDTH);
      expect(next.height).toBeGreaterThanOrEqual(MIN_DOCK_HEIGHT);
      const grown = applyDockDrag(START, handle, 5000, 5000, BOUNDS);
      expect(grown.width).toBeGreaterThanOrEqual(MIN_DOCK_WIDTH);
      expect(grown.height).toBeGreaterThanOrEqual(MIN_DOCK_HEIGHT);
    }
  });

  it('never resizes larger than the canvas it floats over', () => {
    for (const handle of ['e', 'w', 'n', 's', 'se'] as DockHandle[]) {
      const next = applyDockDrag(START, handle, 5000, 5000, BOUNDS);
      expect(next.width).toBeLessThanOrEqual(BOUNDS.width);
      expect(next.height).toBeLessThanOrEqual(BOUNDS.height);
    }
  });

  it('gives every handle a cursor, so no grab area is silently invisible', () => {
    for (const handle of ['move', 'n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as DockHandle[]) {
      expect(HANDLE_CURSOR[handle]).toBeTruthy();
    }
  });
});

describe('clampDock', () => {
  it('pulls a dock back inside a container that just shrank', () => {
    const next = clampDock({ x: 900, bottom: 700, width: 560, height: 280 }, { width: 700, height: 500 });
    expect(next.x).toBeLessThanOrEqual(700 - 100);
    expect(next.bottom + next.height).toBeLessThanOrEqual(500);
    expect(next.width).toBeLessThanOrEqual(700);
  });

  it('leaves a dock that already fits exactly alone', () => {
    expect(clampDock(START, BOUNDS)).toEqual(START);
  });

  it('does nothing at all before the container has been measured', () => {
    // A ResizeObserver's first tick can report 0×0; clamping against that would
    // slam the dock into the corner before it was ever shown.
    expect(clampDock(START, { width: 0, height: 0 })).toEqual(START);
  });
});
