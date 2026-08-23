/**
 * In-app drag and drop, on pointer events rather than HTML5 DnD.
 *
 * **HTML5 drag and drop does not work in this app at all.** Tauri installs a
 * native drag-drop handler on the webview (`dragDropEnabled`, which defaults to
 * true and is what gives OS file drops their real absolute paths), and that
 * handler returns `true` unconditionally — see `tauri-runtime-wry`'s
 * `with_drag_drop_handler`. On macOS wry only forwards the drag to the
 * WKWebView's own handling when the listener returns `false`:
 *
 *     if !listener(DragDropEvent::Enter { .. }) {
 *       msg_send![super(this), draggingEntered: drag_info]   // OS default
 *     } else {
 *       NSDragOperation::Copy                                 // intercepted
 *     }
 *
 * So `dragstart` never fires anywhere in the app. Tab reorder, and every
 * drag-to-context path, were dead from the moment they were written — and the
 * comments claiming in-webview drags were "unaffected by Tauri's native
 * interception" were simply wrong.
 *
 * Turning `dragDropEnabled` off would revive HTML5 DnD, but it also stops
 * `onDragDropEvent` firing, which is the only source of real filesystem paths
 * for OS drops — macOS `File` objects carry none. That would trade the terminal
 * drop, the explorer copy-drop and the Finder-to-chat drop for the in-app ones.
 *
 * Hence this: an in-app drag never needed a `DataTransfer` in the first place.
 * That channel exists to move data BETWEEN processes; within one webview the
 * app already knows what is being dragged, so it can just remember it.
 *
 * Usage:
 *   - a source calls `startPointerDrag(event, payload)` from `onPointerDown`;
 *   - a zone marks itself `data-drop-zone="<id>"` and listens for
 *     `POINTER_DRAG_DROP` on that element.
 * The module owns the threshold, the floating preview, the hover highlight
 * (`data-drag-over`) and cancellation.
 */

/** Travel before a press becomes a drag. Below this it stays a click. */
export const DRAG_THRESHOLD_PX = 5;

/**
 * Dispatched on `window` when a drag is released over a zone.
 *
 * On `window` rather than on the zone element so a React component can
 * subscribe once in an effect and filter by `zoneId`, instead of threading a
 * ref onto every droppable element — which for the tab strip would mean one
 * per tab.
 */
export const POINTER_DRAG_DROP = 'pointer-drag-drop';

export interface PointerDragDropDetail {
  payload: PointerDragPayload;
  /** The `data-drop-zone` value that was under the pointer. */
  zoneId: string;
  /** The zone element itself, for per-instance data attributes. */
  zoneEl: HTMLElement;
}

export interface PointerDragPayload {
  /** Absolute path of the dragged file. */
  path: string;
  isDir: boolean;
  /** Where the drag began, so a zone can accept only what it cares about. */
  origin: 'tab' | 'explorer';
  /** Shown in the floating preview. */
  label: string;
}

export function exceedsDragThreshold(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX;
}

/**
 * The id of the innermost drop zone at or above `el`.
 *
 * Innermost wins so nesting works: a tab inside the tab strip means a drop on
 * the tab reorders, while a drop on the strip's empty space does not.
 */
export function zoneIdOf(el: HTMLElement | null): string | null {
  let node: HTMLElement | null = el;
  while (node) {
    const id = node.getAttribute('data-drop-zone');
    if (id) return id;
    node = node.parentElement;
  }
  return null;
}

// ── Runtime ───────────────────────────────────────────────────────

const PREVIEW_ID = 'pointer-drag-preview';
const HOVER_ATTR = 'data-drag-over';

function clearHover(): void {
  document.querySelectorAll(`[${HOVER_ATTR}]`).forEach((el) => el.removeAttribute(HOVER_ATTR));
}

function removePreview(): void {
  document.getElementById(PREVIEW_ID)?.remove();
}

function createPreview(label: string): HTMLElement {
  removePreview();
  const el = document.createElement('div');
  el.id = PREVIEW_ID;
  el.className = 'pointer-drag-preview';
  el.textContent = label;
  document.body.appendChild(el);
  return el;
}

/**
 * Begin a potential drag from a pointerdown.
 *
 * Nothing happens until the pointer travels past the threshold, so an ordinary
 * click on a tab or a tree row still activates it. Safe to call on every
 * pointerdown.
 */
export function startPointerDrag(
  event: { clientX: number; clientY: number; button: number; pointerId: number },
  payload: PointerDragPayload,
): void {
  // Left button only: a right-click opens a context menu, and a middle-click
  // closes a tab.
  if (event.button !== 0) return;

  const startX = event.clientX;
  const startY = event.clientY;
  let dragging = false;
  let preview: HTMLElement | null = null;

  function onMove(e: PointerEvent) {
    if (!dragging) {
      if (!exceedsDragThreshold(e.clientX - startX, e.clientY - startY)) return;
      dragging = true;
      preview = createPreview(payload.label);
    }

    if (preview) {
      // Offset from the cursor so the preview never sits under the pointer and
      // steals the `elementFromPoint` hit below.
      preview.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`;
    }

    clearHover();
    const zone = zoneElementAt(e.clientX, e.clientY);
    if (zone) zone.setAttribute(HOVER_ATTR, 'true');
  }

  function onUp(e: PointerEvent) {
    cleanup();
    if (!dragging) return;
    const zoneEl = zoneElementAt(e.clientX, e.clientY);
    const zoneId = zoneEl?.getAttribute('data-drop-zone');
    if (!zoneEl || !zoneId) return;
    window.dispatchEvent(
      new CustomEvent<PointerDragDropDetail>(POINTER_DRAG_DROP, {
        detail: { payload, zoneId, zoneEl },
      }),
    );
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') cleanup();
  }

  function cleanup() {
    dragging = false;
    removePreview();
    clearHover();
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', cleanup);
    window.removeEventListener('keydown', onKey);
  }

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', cleanup);
  window.addEventListener('keydown', onKey);
}

/**
 * The drop-zone element under a viewport point.
 *
 * The preview is `pointer-events: none` in CSS, so it cannot win this hit even
 * though it sits above everything.
 */
function zoneElementAt(x: number, y: number): HTMLElement | null {
  const hit = document.elementFromPoint(x, y) as HTMLElement | null;
  const id = zoneIdOf(hit);
  if (!id) return null;
  let node: HTMLElement | null = hit;
  while (node && node.getAttribute('data-drop-zone') !== id) node = node.parentElement;
  return node;
}
