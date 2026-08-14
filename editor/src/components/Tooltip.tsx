import { cloneElement, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { useCommandsStore, type CommandsState } from '../stores/commands';
import { tooltipParts } from './tooltip-chord';

type Side = 'top' | 'bottom' | 'left' | 'right';

interface TooltipProps {
  /** What the control does. Keep it a noun phrase, not a sentence. */
  label: string;
  /**
   * Command this control triggers. Its chord is appended automatically —
   * never spell a chord into `label`, it will go stale and be wrong on at
   * least one platform.
   */
  commandId?: string;
  side?: Side;
  /** Single focusable/hoverable element. */
  children: ReactElement<Record<string, unknown>>;
}

/** How long a pointer must rest before the tooltip appears. */
const OPEN_DELAY_MS = 450;
/**
 * Grace period after closing during which the next tooltip opens instantly.
 * Without it, sweeping along the activity bar makes every icon wait its own
 * 450ms and the row feels unresponsive.
 */
const WARM_MS = 300;
const GAP = 8;

let lastClosedAt = 0;

/**
 * Select the command Map itself — never a value derived from it.
 *
 * Zustand v5 runs a selector as `useSyncExternalStore`'s `getSnapshot`, and
 * React compares consecutive snapshots with `Object.is`. A selector that builds
 * a fresh identity per call (`s.commands.get.bind(s.commands)`, an object
 * literal, `.map(...)`) therefore never compares equal, so React's commit-phase
 * snapshot check force-re-renders on every commit and the component loops until
 * "Maximum update depth exceeded" — which is exactly what this did, taking the
 * whole app down through the root error boundary whenever a store notified
 * often enough to stack 50 of those re-renders (Unity log streaming did it).
 *
 * The Map's identity changes only when a command is registered or unregistered
 * (see stores/commands.ts), so it is a stable snapshot. Derive from it in
 * render, not in the selector.
 */
export const selectCommands = (s: CommandsState) => s.commands;

/**
 * A real tooltip, replacing the native `title=` attribute.
 *
 * `title` cannot be styled, takes roughly a second to appear, never appears at
 * all for keyboard users, and cannot present a keyboard chord legibly. It is
 * the loudest cheap-looking detail in the app, and it is why shortcuts were
 * undiscoverable: 149 `title` attributes existed and exactly one showed its
 * chord.
 *
 * Rendered through a portal so it escapes any `overflow: hidden` ancestor —
 * the activity bar and sidebar both clip.
 */
function Tooltip({ label, commandId, side = 'right', children }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();

  const commands = useCommandsStore(selectCommands);
  const { label: text, chord } = tooltipParts(label, commandId, (cid) => commands.get(cid));

  const close = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setOpen((wasOpen) => {
      if (wasOpen) lastClosedAt = Date.now();
      return false;
    });
  }, []);

  const place = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const mid = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const raw =
      side === 'right'
        ? { top: mid.y, left: r.right + GAP }
        : side === 'left'
          ? { top: mid.y, left: r.left - GAP }
          : side === 'bottom'
            ? { top: r.bottom + GAP, left: mid.x }
            : { top: r.top - GAP, left: mid.x };
    // Clamp into the viewport; a tooltip half off-screen is worse than none.
    setPos({
      top: Math.max(GAP, Math.min(window.innerHeight - GAP, raw.top)),
      left: Math.max(GAP, Math.min(window.innerWidth - GAP, raw.left)),
    });
  }, [side]);

  const scheduleOpen = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    const warm = Date.now() - lastClosedAt < WARM_MS;
    timer.current = setTimeout(
      () => {
        place();
        setOpen(true);
      },
      warm ? 0 : OPEN_DELAY_MS,
    );
  }, [place]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    // Any scroll invalidates the measured position, and re-measuring during a
    // scroll fights the user. Closing is the honest response.
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
    };
  }, [open, close]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const child = cloneElement(children, {
    ref: (node: HTMLElement | null) => {
      anchorRef.current = node;
      // Preserve whatever ref the caller already had.
      const orig = (children as unknown as { ref?: unknown }).ref;
      if (typeof orig === 'function') orig(node);
      else if (orig && typeof orig === 'object') {
        (orig as { current: HTMLElement | null }).current = node;
      }
    },
    onMouseEnter: scheduleOpen,
    onMouseLeave: close,
    // Keyboard users never saw a native tooltip at all.
    onFocus: scheduleOpen,
    onBlur: close,
    // Clicking a control means the user already knows what it does.
    onPointerDown: close,
    'aria-describedby': open ? id : undefined,
    // The accessible name must survive even while the tooltip is hidden.
    'aria-label': children.props['aria-label'] ?? text,
  } as Record<string, unknown>);

  return (
    <>
      {child}
      {open &&
        pos &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            className={`app-tooltip app-tooltip--${side}`}
            style={{ top: pos.top, left: pos.left }}
          >
            <span className="app-tooltip-label">{text}</span>
            {chord && <kbd className="app-tooltip-chord">{chord}</kbd>}
          </div>,
          document.body,
        )}
    </>
  );
}

export default Tooltip;
