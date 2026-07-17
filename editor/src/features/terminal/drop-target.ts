import { invoke } from '@tauri-apps/api/core';
import { escapePathForShell } from './shell-escape';
import { focusTerminalById } from './terminal-registry';

const DROP_OVER_CLASS = 'terminal-xterm--drop-over';

/**
 * Which terminal pane, if any, sits under a point in CSS pixels.
 *
 * Hit-testing by hand rather than reading the event target, because Tauri
 * handles OS file drops natively (`dragDropEnabled` defaults to true) and the
 * webview never sees a DOM drop event — all we are given is a window
 * coordinate.
 */
function terminalAtPoint(cssX: number, cssY: number): { id: number; el: HTMLElement } | null {
  const panes = document.querySelectorAll<HTMLElement>('.terminal-xterm[data-terminal-id]');
  for (const el of panes) {
    const r = el.getBoundingClientRect();
    // Inactive tabs/groups are display:none and collapsed panels are 0-height;
    // both measure empty and must never win a hit-test.
    if (r.width === 0 || r.height === 0) continue;
    if (cssX >= r.left && cssX <= r.right && cssY >= r.top && cssY <= r.bottom) {
      const id = Number(el.dataset.terminalId);
      if (Number.isFinite(id)) return { id, el };
    }
  }
  return null;
}

/**
 * Converts a Tauri drag-drop position to CSS pixels.
 *
 * The payload is a PhysicalPosition while `getBoundingClientRect()` is in CSS
 * pixels — on a Retina display those differ by 2x, so skipping this puts every
 * drop in the wrong quadrant of the window.
 */
function toCssPoint(position: { x: number; y: number }): { x: number; y: number } {
  const dpr = window.devicePixelRatio || 1;
  return { x: position.x / dpr, y: position.y / dpr };
}

function clearHighlight(): void {
  document
    .querySelectorAll<HTMLElement>(`.${DROP_OVER_CLASS}`)
    .forEach((el) => el.classList.remove(DROP_OVER_CLASS));
}

/** Highlights the pane under the cursor while a drag is over the window. */
export function highlightTerminalDropTarget(position: { x: number; y: number }): void {
  const { x, y } = toCssPoint(position);
  const hit = terminalAtPoint(x, y);
  clearHighlight();
  hit?.el.classList.add(DROP_OVER_CLASS);
}

export function clearTerminalDropTarget(): void {
  clearHighlight();
}

/**
 * If `position` is over a terminal, types the dropped paths into it and returns
 * true; otherwise returns false so the caller can fall back to opening them.
 *
 * This is VS Code's behaviour: dropping a file on a terminal inserts its
 * escaped path rather than opening it. It is also how you attach an image to
 * Claude Code by dragging, since a terminal can only ever receive text.
 */
export async function handleTerminalDrop(
  position: { x: number; y: number },
  paths: string[]
): Promise<boolean> {
  clearHighlight();
  if (paths.length === 0) return false;

  const { x, y } = toCssPoint(position);
  const hit = terminalAtPoint(x, y);
  if (!hit) return false;

  // Space-separated and individually quoted, so multiple files arrive as
  // distinct arguments. No trailing newline: inserting the path is the
  // equivalent of typing it, and deciding to run it is the user's.
  const text = paths.map((p) => escapePathForShell(p)).join(' ');
  try {
    await invoke('terminal_write', { id: hit.id, data: text });
  } catch {
    return false;
  }
  focusTerminalById(hit.id);
  return true;
}
