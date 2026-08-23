/**
 * OS file drops onto the AI panel — stages the dropped files as chat context.
 *
 * Hit-tests by hand rather than reading an event target, for the reason
 * `explorer/services/drop-target.ts` documents: Tauri handles OS file drops
 * natively (`dragDropEnabled` defaults to true), so the webview never sees a
 * DOM drop event and all we are given is a window coordinate. In-webview drags
 * (explorer tree, tab bar) are a different mechanism entirely and are handled
 * by `AiChatPanel`'s own React drop handlers.
 *
 * Pure geometry and predicates live here; the staging itself stays in the panel
 * so there is one place that decides what a dropped file becomes.
 */

import { rectContains, toCssPoint } from '../../../utils/drop-point';

/** Mirrors the class `AiChatPanel` toggles for in-webview drags. */
const DROP_OVER_CLASS = 'ai-panel--drop-over';

/**
 * The panel element, when it is actually on screen.
 *
 * A panel in a collapsed sidebar still exists in the DOM and measures zero, and
 * a zero-size rect contains no point — but the explicit check says so rather
 * than relying on that arithmetic holding.
 */
function panelAtPoint(cssX: number, cssY: number): HTMLElement | null {
  // `querySelectorAll`, not `querySelector`: the maximized overlay mounts a
  // second `.ai-panel` at the App root while the docked one is unmounted, and
  // during the swap both can briefly be present. Take whichever contains the
  // point and has a real size.
  for (const el of document.querySelectorAll<HTMLElement>('.ai-panel')) {
    if (rectContains(el.getBoundingClientRect(), cssX, cssY)) return el;
  }
  return null;
}

/** Highlights the panel while an OS drag is over it. */
export function highlightAiPanelDropTarget(position: { x: number; y: number }): void {
  const { x, y } = toCssPoint(position, window.devicePixelRatio);
  clearAiPanelDropTarget();
  panelAtPoint(x, y)?.classList.add(DROP_OVER_CLASS);
}

export function clearAiPanelDropTarget(): void {
  document
    .querySelectorAll<HTMLElement>(`.${DROP_OVER_CLASS}`)
    .forEach((el) => el.classList.remove(DROP_OVER_CLASS));
}

/**
 * True when a drop at `position` landed on the AI panel.
 *
 * The caller stages the paths; this only answers "was it here?", so the
 * decision about what a dropped file becomes stays in one place.
 */
export function isDropOnAiPanel(position: { x: number; y: number }): boolean {
  const { x, y } = toCssPoint(position, window.devicePixelRatio);
  return panelAtPoint(x, y) !== null;
}
