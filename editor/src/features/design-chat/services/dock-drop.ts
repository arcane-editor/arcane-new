/**
 * OS file drops onto the design dock.
 *
 * Hit-tested by hand rather than read off an event target, for the reason
 * `ai-panel/services/drop-target.ts` documents: Tauri handles OS file drops
 * natively, so the webview never sees a DOM drop event and all we are given is
 * a window coordinate. HTML5 drag and drop does not work anywhere in this app.
 *
 * Geometry and predicates only. What a dropped file BECOMES is the dock's
 * decision, so that stays in the component — here as in the panel.
 */

import { rectContains, toCssPoint } from '../../../utils/drop-point';

/** Toggled while an OS drag is over the dock, so the target is visible before you let go. */
const DROP_OVER_CLASS = 'design-dock--drop-over';

/** The event the dock listens for. Mirrors the panel's `ai-stage-paths`. */
export const DESIGN_STAGE_PATHS = 'design-stage-paths';

function dockAtPoint(cssX: number, cssY: number): HTMLElement | null {
  // A dock in a closed state is not in the DOM at all, and a collapsed one
  // still measures — so the only case to exclude is a zero-size element, which
  // `rectContains` already rejects.
  for (const el of document.querySelectorAll<HTMLElement>('.design-dock')) {
    if (rectContains(el.getBoundingClientRect(), cssX, cssY)) return el;
  }
  return null;
}

export function highlightDesignDockDropTarget(position: { x: number; y: number }): void {
  const { x, y } = toCssPoint(position, window.devicePixelRatio);
  clearDesignDockDropTarget();
  dockAtPoint(x, y)?.classList.add(DROP_OVER_CLASS);
}

export function clearDesignDockDropTarget(): void {
  document
    .querySelectorAll<HTMLElement>(`.${DROP_OVER_CLASS}`)
    .forEach((el) => el.classList.remove(DROP_OVER_CLASS));
}

/** True when a drop at `position` landed on the dock. */
export function isDropOnDesignDock(position: { x: number; y: number }): boolean {
  const { x, y } = toCssPoint(position, window.devicePixelRatio);
  return dockAtPoint(x, y) !== null;
}
