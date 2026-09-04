import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clampViewport,
  fitViewport,
  isFitted,
  panBy,
  stepZoom,
  wheelZoomFactor,
  zoomAt,
  type Size,
  type Viewport,
} from '../services/viewport';

/**
 * The preview canvas's camera: viewport state, plus the DOM input wiring that
 * drives it.
 *
 * Split from `services/viewport.ts` along the testable seam — the arithmetic is
 * pure and covered there, and everything here is the part that needs a browser
 * (a ResizeObserver, a non-passive wheel listener, pointer capture). Split from
 * `PreviewCanvas` because the toolbar in the editor's header drives the same
 * camera the canvas renders, and passing a dozen callbacks through the canvas
 * to reach it would be worse than both reading one hook.
 */

/** What sits behind the document. See `PreviewCanvas` for why it is a choice. */
export type StageBackground = 'dark' | 'light' | 'checker';

export interface PreviewCamera {
  viewport: Viewport;
  /** Attach to the scrolling/clipping canvas element — measured and listened to. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** The canvas's measured size, in CSS pixels. Zero until the first measure. */
  container: Size;
  /** True while the camera still sits where `fit` put it. Lights the Fit button. */
  fitted: boolean;
  /** A drag is in progress. */
  panning: boolean;
  /** Space is down, so a drag anywhere — including over the stage — will pan. */
  spaceHeld: boolean;
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  actualSize: () => void;
  /** Spread onto the canvas element. */
  handlers: {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerEnter: () => void;
    onPointerLeave: () => void;
    onClickCapture: (e: React.MouseEvent) => void;
  };
}

/**
 * A wheel event's delta in CSS pixels.
 *
 * Firefox reports `deltaMode: 1` (lines) for a real mouse wheel, so its raw
 * deltas are ~3 rather than ~100 — read as pixels, a notch would pan three
 * pixels and zoom imperceptibly.
 */
const LINE_HEIGHT = 16;

/**
 * How long a pan's own `click` stays suppressed. The browser raises it in the
 * same turn as the `pointerup`, so this only has to outlast a busy frame — and
 * has to stay well under a deliberate re-click, or the pan would eat that too.
 */
const CLICK_SUPPRESS_MS = 200;

/**
 * Travel before a press becomes a pan rather than a click.
 *
 * This threshold is the ONLY thing separating "pan the canvas" from "select
 * this element", which is what lets a drag start anywhere — including on top of
 * the document. The previous rule, panning only from the empty canvas around
 * the stage, was unusable in practice: the stage covers nearly the whole
 * canvas, so it left a thin margin as the only place a drag would take.
 *
 * 4px matches `pointer-drag.ts`'s intent closely enough to feel like one app.
 */
const DRAG_THRESHOLD_PX = 4;

function deltaScale(mode: number, viewportHeight: number): number {
  if (mode === 1) return LINE_HEIGHT;
  if (mode === 2) return viewportHeight;
  return 1;
}

/**
 * Whether a key event belongs to something the user is typing into.
 *
 * The canvas claims bare `+`, `-`, `0`, `1` and Space, which are all ordinary
 * characters. Monaco's input surface is a real `textarea`, so this covers the
 * editor as well as the inspector's fields.
 *
 * `closest` is sound HERE, unlike in `overStage`, only because the preview's
 * shadow root holds a static rendering of the document and nothing focusable:
 * the fields this has to find are all in the light DOM. Do not reuse the
 * pattern for anything that has to see a node inside the preview.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return !!el.closest('input, textarea, select, [contenteditable="true"]');
}

export function usePreviewCamera(content: Size, padding: number): PreviewCamera {
  const containerRef = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState<Size>({ width: 0, height: 0 });
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);

  // Whether the user has taken the camera off the fit. Until they do, the view
  // re-fits on every resize; afterwards their framing survives one.
  const [moved, setMoved] = useState(false);

  // Read by listeners rather than closed over, so the native wheel listener and
  // the window key listener can be attached once instead of on every measure.
  const hovered = useRef(false);
  const focused = useRef(false);
  const pan = useRef<{
    id: number;
    button: number;
    /** Where the press landed. Deltas run from here until the drag activates. */
    x: number;
    y: number;
    /** True once travel passed the threshold and this became a real pan. */
    active: boolean;
  } | null>(null);
  // A DEADLINE, not a flag. See `endPan`.
  const suppressClickUntil = useRef(0);
  const bounds = useRef({ content, container });
  bounds.current = { content, container };

  const { width: contentWidth, height: contentHeight } = content;

  const fitTarget = useMemo(
    () => fitViewport(content, container, padding),
    [content, container, padding],
  );

  // Every camera change funnels through here, so no gesture can leave the stage
  // somewhere the mouse cannot reach it.
  const move = useCallback((next: (vp: Viewport) => Viewport) => {
    setViewport((vp) => clampViewport(next(vp), bounds.current.content, bounds.current.container));
    setMoved(true);
  }, []);

  const centre = useCallback(
    () => ({ x: bounds.current.container.width / 2, y: bounds.current.container.height / 2 }),
    [],
  );

  const fit = useCallback(() => {
    setViewport(fitViewport(bounds.current.content, bounds.current.container, padding));
    setMoved(false);
  }, [padding]);

  const zoomIn = useCallback(() => move((vp) => stepZoom(vp, 1, centre())), [move, centre]);
  const zoomOut = useCallback(() => move((vp) => stepZoom(vp, -1, centre())), [move, centre]);
  const actualSize = useCallback(() => move((vp) => zoomAt(vp, 1, centre())), [move, centre]);

  // Measure the canvas. Compared before storing, because a ResizeObserver that
  // sets unchanged state re-renders, which can re-observe, which fires again.
  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const next = { width: node.clientWidth, height: node.clientHeight };
      setContainer((prev) =>
        prev.width === next.width && prev.height === next.height ? prev : next,
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  // Track the fit while the user has not taken over. This is also what places
  // the camera on first paint, once the canvas has a size to fit against.
  useEffect(() => {
    if (!moved) setViewport(fitTarget);
  }, [fitTarget, moved]);

  // A new coordinate space is a new picture: when the panel's layout box
  // changes, whatever the old camera framed no longer means anything.
  useEffect(() => {
    setMoved(false);
  }, [contentWidth, contentHeight]);

  /**
   * Wheel: pan, or zoom under the cursor when the gesture is a pinch.
   *
   * Attached natively rather than through `onWheel` because React registers
   * wheel at the root as PASSIVE, where `preventDefault` is ignored with a
   * console warning — the page would scroll and the browser would zoom right
   * through every gesture here.
   *
   * A macOS trackpad pinch arrives as a wheel event with `ctrlKey` set, which
   * is why one branch covers both pinch and Ctrl/Cmd+wheel.
   */
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = node.getBoundingClientRect();
      const scale = deltaScale(e.deltaMode, rect.height);
      if (e.ctrlKey || e.metaKey) {
        const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        move((vp) => zoomAt(vp, vp.zoom * wheelZoomFactor(e.deltaY * scale), anchor));
      } else {
        // Scrolling down moves the content up, as it does in every scrolling
        // surface — so the deltas are subtracted, not added.
        move((vp) => panBy(vp, -e.deltaX * scale, -e.deltaY * scale));
      }
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [move]);

  /**
   * Keys, scoped to a hovered or focused canvas.
   *
   * Deliberately UNMODIFIED: `mod+equal`, `mod+minus` and `mod+0` are already
   * bound app-wide to window zoom, and `mod+1`..`mod+9` to tab switching, so a
   * modified chord here would either lose to those or quietly break them. The
   * scope is what makes bare keys safe, together with `isTypingTarget`.
   */
  useEffect(() => {
    const active = () => hovered.current || focused.current;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!active() || isTypingTarget(e.target)) return;
      if (e.code === 'Space') {
        // Held, not toggled — and prevented, or the surrounding page scrolls.
        e.preventDefault();
        setSpaceHeld(true);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // A switch rather than a lookup object, so an unrelated `e.key` cannot
      // reach `Object.prototype` and come back as a callable.
      // `+`/`_` are the shifted forms of `=`/`-`; both spellings arrive
      // depending on whether the user reached for Shift.
      switch (e.key) {
        case '+':
        case '=':
          zoomIn();
          break;
        case '-':
        case '_':
          zoomOut();
          break;
        case '0':
          fit();
          break;
        case '1':
          actualSize();
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false);
    };
    // Without this, tabbing away mid-drag leaves the canvas stuck in pan mode
    // with no key event coming to release it.
    const onBlur = () => setSpaceHeld(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [zoomIn, zoomOut, fit, actualSize]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const onFocus = () => {
      focused.current = true;
    };
    const onBlur = () => {
      focused.current = false;
    };
    node.addEventListener('focusin', onFocus);
    node.addEventListener('focusout', onBlur);
    return () => {
      node.removeEventListener('focusin', onFocus);
      node.removeEventListener('focusout', onBlur);
    };
  }, []);

  // `onPointerDown` is created once, so it reads Space through a ref rather
  // than closing over a stale value from the render it was created in.
  const spaceHeldRef = useRef(spaceHeld);
  spaceHeldRef.current = spaceHeld;

  /**
   * Drag to pan — on the middle button, with Space held, or from the empty
   * canvas around the stage.
   *
   * A left drag that starts ON the stage is left alone so click-to-select keeps
   * working.
   */
  /**
   * Commit to panning: take the pointer so the drag survives leaving the canvas,
   * and stop the browser turning it into a text selection.
   *
   * Deliberately NOT done on `pointerdown`. Capturing there is what broke
   * click-to-select: capture retargets the `pointerup` to the canvas, so the
   * browser fires `click` on the common ancestor and the element never sees it.
   * Committing only once the pointer has actually travelled leaves an ordinary
   * click untouched.
   */
  const beginPan = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Stops middle-click autoscroll and any text selection the drag would start.
    e.preventDefault();
    setPanning(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Explicit: the gesture may go on to `preventDefault`, which suppresses the
    // compatibility `mousedown` that would otherwise focus the canvas — leaving
    // the zoom keys working on hover but not after a click.
    e.currentTarget.focus?.({ preventScroll: true });
    // A new gesture retires any click still pending suppression.
    suppressClickUntil.current = 0;
    if (e.button !== 0 && e.button !== 1) return;

    // The middle button and Space are unambiguous: nothing else claims them, so
    // they pan from the first pixel. A plain left press stays PENDING until it
    // moves, because it might still turn out to be a click on an element.
    const immediate = e.button === 1 || spaceHeldRef.current;
    pan.current = {
      id: e.pointerId,
      button: e.button,
      x: e.clientX,
      y: e.clientY,
      active: immediate,
    };
    if (immediate) beginPan(e);
  }, [beginPan]);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const active = pan.current;
      if (!active || active.id !== e.pointerId) return;

      // Deltas run from the PRESS, not from the last move, so the travel spent
      // reaching the threshold is not silently dropped — otherwise the content
      // lags the pointer by the threshold for the whole drag.
      const dx = e.clientX - active.x;
      const dy = e.clientY - active.y;
      if (!active.active) {
        if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD_PX) return;
        active.active = true;
        beginPan(e);
      }
      active.x = e.clientX;
      active.y = e.clientY;
      move((vp) => panBy(vp, dx, dy));
    },
    [move, beginPan],
  );

  const endPan = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const active = pan.current;
    if (!active || active.id !== e.pointerId) return;
    /*
     * A LEFT drag that ended over the stage is about to raise a `click` there,
     * which would select whatever the pan happened to finish on top of.
     *
     * A DEADLINE rather than a boolean, because the click being suppressed is
     * not guaranteed to arrive: a middle-drag raises `auxclick` instead, and a
     * left drag released outside the window may raise nothing at all. A sticky
     * flag would stay armed through all of that and silently eat the user's
     * next real selection, however much later it came. The browser dispatches
     * the drag's click in the same turn as the `pointerup`, so any window that
     * clears within a human re-click is both sufficient and self-healing.
     */
    suppressClickUntil.current =
      active.active && active.button === 0 ? Date.now() + CLICK_SUPPRESS_MS : 0;
    pan.current = null;
    setPanning(false);
    // Asked first: `releasePointerCapture` THROWS for a pointer it never held,
    // and capture can be lost without notice — a `pointercancel` from the OS
    // taking over the gesture already released it.
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (Date.now() > suppressClickUntil.current) return;
    suppressClickUntil.current = 0;
    e.stopPropagation();
    e.preventDefault();
  }, []);

  const handlers = useMemo(
    () => ({
      onPointerDown,
      onPointerMove,
      onPointerUp: endPan,
      onPointerCancel: endPan,
      onPointerEnter: () => {
        hovered.current = true;
      },
      onPointerLeave: () => {
        hovered.current = false;
      },
      onClickCapture,
    }),
    [onPointerDown, onPointerMove, endPan, onClickCapture],
  );

  return {
    viewport,
    containerRef,
    container,
    fitted: !moved && isFitted(viewport, fitTarget),
    panning,
    spaceHeld,
    zoomIn,
    zoomOut,
    fit,
    actualSize,
    handlers,
  };
}
