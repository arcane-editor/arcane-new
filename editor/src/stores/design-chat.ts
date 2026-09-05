/**
 * The design dock's own state: whether it is showing, and where it sits.
 *
 * Deliberately NOT the conversation. The transcript, the streaming state and
 * the agent lifecycle all stay in `stores/ai.ts`, because there is one agent
 * runtime and one live conversation — the dock is a second view onto it, not a
 * second chat. What lives here is only what a floating panel needs: geometry,
 * open/collapsed, and the unsent draft.
 *
 * Geometry persists through `localStorage`. It is a window position, so losing
 * it costs a drag and nothing else; that is not worth a round trip to disk on
 * every pointer move.
 */

import { create } from 'zustand';

/** Where the dock sits, in canvas-relative pixels. */
export interface DockGeometry {
  /** Distance from the canvas's left edge. */
  x: number;
  /** Distance from the canvas's BOTTOM edge — the dock is a shelf, so it grows upward. */
  bottom: number;
  width: number;
  height: number;
}

export const MIN_DOCK_WIDTH = 320;
export const MIN_DOCK_HEIGHT = 150;

/**
 * Sizes for a first open: wide enough for a file row plus its counts without
 * wrapping, short enough that the artboard above it is still the thing you are
 * looking at.
 */
export const DEFAULT_GEOMETRY: DockGeometry = { x: 0, bottom: 18, width: 560, height: 280 };

const GEOMETRY_KEY = 'unityide.designDock.geometry';
const OPEN_KEY = 'unityide.designDock.open';
const ATTACH_RENDER_KEY = 'unityide.designDock.attachRender';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? ({ ...fallback, ...(JSON.parse(raw) as object) } as T) : fallback;
  } catch {
    // A private window, cleared site data, or storage denied outright. The
    // defaults are a complete answer to all three.
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Remembering a position is a convenience, not a promise.
  }
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * The last picture of the screen, produced after a design write.
 *
 * `dataUrl` is null when the render could not be captured — WebKit declining
 * the `foreignObject`, a tainted canvas, a document with no root. That is a
 * distinct state from "no render yet", and the dock says so: showing the
 * PREVIOUS turn's picture beside this turn's writes would answer "what did that
 * do" with the wrong screen.
 */
export interface DesignRender {
  /** Which document it is of, so a tab switch cannot show the wrong one. */
  documentPath: string;
  /** PNG data URL, or null when the capture failed. */
  dataUrl: string | null;
  at: number;
  /**
   * True once this render has been handed to the model. The next send attaches
   * a render the model has not seen; re-attaching the same picture every turn
   * would pay vision tokens for something already in the conversation.
   */
  sent: boolean;
}

interface DesignChatState {
  /**
   * Whether the dock is over the canvas at all.
   *
   * Defaults to TRUE. It shipped off-by-default behind a small toolbar toggle
   * and was, reasonably, never found — a surface whose whole job is to be the
   * obvious way to change the screen cannot be the one you have to go looking
   * for. The toolbar button now closes it, not opens it.
   */
  open: boolean;
  /** Collapsed to the header + composer, keeping the transcript out of the way. */
  collapsed: boolean;
  geometry: DockGeometry;
  /**
   * True once the user has positioned it by hand, after which it stops
   * re-centring itself on every canvas resize — the same "they took over, so
   * stop moving it for them" rule `usePreviewCamera` applies to the camera.
   */
  placed: boolean;
  /**
   * The unsent composer text.
   *
   * Here rather than in the component because the dock unmounts every time you
   * switch tabs — `EditorPanel` renders it only for a `.uxml` — and losing a
   * half-written instruction to a glance at the stylesheet next door would be
   * its own small betrayal.
   */
  draft: string;
  /** The latest render of the session document. Null until a design write produces one. */
  render: DesignRender | null;
  /**
   * The document whose thread the user deliberately started fresh.
   *
   * A new thread has no session id until its first message mints one, and
   * `adoptDesignSession` runs on every send — so without this marker the send
   * right after "New chat" would find the document's previous saved thread and
   * load it, putting the transcript the user just cleared back on screen with
   * their new message appended. Deliberately NOT persisted: it describes an
   * intent within one sitting, not a setting.
   */
  freshThread: string | null;
  setDraft: (draft: string) => void;
  setRender: (documentPath: string, dataUrl: string | null) => void;
  setFreshThread: (documentPath: string | null) => void;
  /**
   * Forget the current render.
   *
   * Called when the thread changes. A render is "what that turn produced", and
   * a new or reopened thread has produced nothing — leaving the last one up
   * would put a picture above an empty transcript, which reads as the result of
   * a turn that never happened.
   */
  clearRender: () => void;
  /** Mark the current render as handed to the model. */
  markRenderSent: () => void;
  /**
   * Whether the latest render is attached to the next message.
   *
   * On by default — seeing the screen is the point — but persistently
   * switchable, because whether the routed model accepts images at all is not
   * something this editor can check (the server picks the model per tier and
   * publishes no vision capability). One click is the difference between
   * finding that out and losing the design chat to it.
   */
  attachRender: boolean;
  setAttachRender: (attach: boolean) => void;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  setCollapsed: (collapsed: boolean) => void;
  /** `byHand` false is the auto-centring pass: it neither persists nor claims the dock. */
  setGeometry: (geometry: DockGeometry, byHand?: boolean) => void;
}

export const useDesignChatStore = create<DesignChatState>((set, get) => ({
  open: read(OPEN_KEY, { open: true }).open,
  collapsed: false,
  placed: false,
  draft: '',
  render: null,
  freshThread: null,
  attachRender: read(ATTACH_RENDER_KEY, { attachRender: true }).attachRender,
  geometry: (() => {
    const stored = read(GEOMETRY_KEY, DEFAULT_GEOMETRY);
    return {
      x: num(stored.x, DEFAULT_GEOMETRY.x),
      bottom: num(stored.bottom, DEFAULT_GEOMETRY.bottom),
      width: Math.max(MIN_DOCK_WIDTH, num(stored.width, DEFAULT_GEOMETRY.width)),
      height: Math.max(MIN_DOCK_HEIGHT, num(stored.height, DEFAULT_GEOMETRY.height)),
    };
  })(),

  setDraft: (draft) => set({ draft }),
  setCollapsed: (collapsed) => set({ collapsed }),

  // Deliberately not persisted: a PNG data URL of a 1280px screen is hundreds
  // of kilobytes, `localStorage` is a ~5MB budget shared with everything else
  // the app remembers, and a render is only meaningful next to the turn that
  // produced it.
  setRender: (documentPath, dataUrl) =>
    set({ render: { documentPath, dataUrl, at: Date.now(), sent: false } }),

  setFreshThread: (freshThread) => set({ freshThread }),

  clearRender: () => set({ render: null }),

  markRenderSent: () => {
    const render = get().render;
    if (render && !render.sent) set({ render: { ...render, sent: true } });
  },

  setAttachRender: (attachRender) => {
    set({ attachRender });
    write(ATTACH_RENDER_KEY, { attachRender });
  },

  setOpen: (open) => {
    set({ open });
    write(OPEN_KEY, { open });
  },
  toggleOpen: () => get().setOpen(!get().open),

  setGeometry: (geometry, byHand = true) => {
    set({ geometry, placed: byHand || get().placed });
    if (byHand) write(GEOMETRY_KEY, geometry);
  },
}));
