/**
 * The geometry maths for dragging and resizing the dock.
 *
 * Pure, and separate from the component, because this is the part that is
 * actually easy to get wrong: the dock is anchored by its LEFT and its BOTTOM,
 * so the four edges do four different things to the four numbers, and three of
 * them are counter-intuitive. Dragging the bottom edge downwards makes the box
 * TALLER, because the top is what stays put.
 *
 * `bottom` is measured from the container's bottom edge, so screen-down (`dy`
 * positive) is `bottom` decreasing. That single inversion is the source of
 * every sign in here.
 */

import type { DockGeometry } from '../../../stores/design-chat';
import { MIN_DOCK_WIDTH, MIN_DOCK_HEIGHT } from '../../../stores/design-chat';

/** Move, the four edges, and the four corners. */
export type DockHandle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export interface Bounds {
  width: number;
  height: number;
}

/** How much of the dock must stay reachable after a move, in each axis. */
const KEEP_VISIBLE = 120;
/** Breathing room the dock cannot be resized past, so it never fills the canvas edge to edge. */
const MARGIN = 12;

export const HANDLE_CURSOR: Record<DockHandle, string> = {
  move: 'grab',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
};

function has(handle: DockHandle, edge: 'n' | 's' | 'e' | 'w'): boolean {
  return handle !== 'move' && handle.includes(edge);
}

function clamp(value: number, min: number, max: number): number {
  // `max` first: a container smaller than the minimum would otherwise clamp
  // upward into a dock bigger than the space it is in.
  return Math.max(min, Math.min(max, value));
}

/**
 * Apply a pointer delta to the geometry a drag started from.
 *
 * Takes the START geometry rather than the current one, so a drag is always
 * computed from a fixed origin — accumulating deltas frame by frame lets
 * rounding and clamping drift the box away from the pointer.
 */
export function applyDockDrag(
  start: DockGeometry,
  handle: DockHandle,
  dx: number,
  dy: number,
  bounds: Bounds,
): DockGeometry {
  const maxWidth = Math.max(MIN_DOCK_WIDTH, bounds.width - MARGIN * 2);
  const maxHeight = Math.max(MIN_DOCK_HEIGHT, bounds.height - MARGIN * 2);

  if (handle === 'move') {
    return {
      ...start,
      x: clamp(start.x + dx, KEEP_VISIBLE - start.width, bounds.width - KEEP_VISIBLE),
      bottom: clamp(start.bottom - dy, 0, Math.max(0, bounds.height - start.height)),
    };
  }

  let { x, bottom, width, height } = start;

  if (has(handle, 'e')) {
    width = clamp(start.width + dx, MIN_DOCK_WIDTH, maxWidth);
  }
  if (has(handle, 'w')) {
    // The right edge stays put, so the width absorbs the move and `x` follows.
    width = clamp(start.width - dx, MIN_DOCK_WIDTH, maxWidth);
    x = start.x + (start.width - width);
  }
  if (has(handle, 'n')) {
    // Bottom fixed: dragging the top edge up (dy negative) grows the box.
    height = clamp(start.height - dy, MIN_DOCK_HEIGHT, Math.max(MIN_DOCK_HEIGHT, bounds.height - start.bottom - MARGIN));
  }
  if (has(handle, 's')) {
    // Top fixed: dragging the bottom edge down (dy positive) grows the box, and
    // `bottom` moves down with it.
    height = clamp(start.height + dy, MIN_DOCK_HEIGHT, Math.min(maxHeight, start.bottom + start.height));
    bottom = start.bottom + start.height - height;
  }

  return { x, bottom, width, height };
}

/**
 * Keep a dock inside a container that just changed size.
 *
 * Called on every canvas resize, so a dock parked at the right edge does not
 * end up off-screen when the inspector opens or the window narrows.
 */
export function clampDock(geometry: DockGeometry, bounds: Bounds): DockGeometry {
  if (bounds.width <= 0 || bounds.height <= 0) return geometry;
  const width = clamp(geometry.width, MIN_DOCK_WIDTH, Math.max(MIN_DOCK_WIDTH, bounds.width - MARGIN * 2));
  const height = clamp(geometry.height, MIN_DOCK_HEIGHT, Math.max(MIN_DOCK_HEIGHT, bounds.height - MARGIN * 2));
  return {
    width,
    height,
    x: clamp(geometry.x, KEEP_VISIBLE - width, Math.max(KEEP_VISIBLE - width, bounds.width - KEEP_VISIBLE)),
    bottom: clamp(geometry.bottom, 0, Math.max(0, bounds.height - height)),
  };
}
