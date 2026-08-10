import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const OPEN_DELAY_MS = 450;
const WARM_MS = 300;
const GAP = 8;

interface Shown {
  text: string;
  top: number;
  left: number;
  side: 'top' | 'bottom' | 'left' | 'right';
}

/**
 * Upgrades every remaining native `title` attribute to the styled tooltip.
 *
 * There were 149 `title=` attributes across the app. The native tooltip cannot
 * be styled, takes roughly a second to appear, never appears for keyboard
 * users, and renders at the pointer rather than against the control.
 *
 * Wrapping each site in `<Tooltip>` is right where a control has a *command*
 * whose chord should be advertised — those are converted individually. For the
 * long tail of icon buttons with no chord, delegation upgrades all of them at
 * once, with no per-site edit and therefore no chance of breaking a panel
 * while doing it.
 *
 * `<Tooltip>` sets `aria-label`, never `title`, so a converted control is
 * invisible here and the two cannot double up.
 */
function TooltipHost() {
  const [shown, setShown] = useState<Shown | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastClosedAt = useRef(0);
  // The element whose `title` is currently blanked, and its original value.
  const suppressed = useRef<{ el: HTMLElement; title: string } | null>(null);

  useEffect(() => {
    function restore() {
      const s = suppressed.current;
      if (s) {
        // Only put it back if nothing else has since set one — a re-render may
        // have already restored it, and clobbering that would be wrong.
        if (!s.el.getAttribute('title')) s.el.setAttribute('title', s.title);
        suppressed.current = null;
      }
    }

    function hide() {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      restore();
      setShown((was) => {
        if (was) lastClosedAt.current = Date.now();
        return null;
      });
    }

    function onOver(e: PointerEvent) {
      const target = (e.target as HTMLElement | null)?.closest?.('[title]') as HTMLElement | null;
      if (!target) {
        if (suppressed.current) hide();
        return;
      }
      if (target === suppressed.current?.el) return;

      const title = target.getAttribute('title') ?? '';
      if (!title.trim()) return;

      hide();
      // Blank rather than remove, so `closest('[title]')` still matches this
      // element on subsequent moves within it and we do not re-trigger.
      suppressed.current = { el: target, title };
      target.setAttribute('title', '');

      const warm = Date.now() - lastClosedAt.current < WARM_MS;
      timer.current = setTimeout(
        () => {
          const r = target.getBoundingClientRect();
          // Prefer below; flip above when there is no room. Panels sit at the
          // window edges, so a fixed side would clip constantly.
          const below = r.bottom + GAP;
          const side = below + 40 > window.innerHeight ? 'top' : 'bottom';
          setShown({
            text: title,
            top: side === 'bottom' ? below : r.top - GAP,
            left: Math.max(GAP, Math.min(window.innerWidth - GAP, r.left + r.width / 2)),
            side,
          });
        },
        warm ? 0 : OPEN_DELAY_MS,
      );
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') hide();
    }

    document.addEventListener('pointerover', onOver, true);
    document.addEventListener('pointerdown', hide, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerover', onOver, true);
      document.removeEventListener('pointerdown', hide, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
      window.removeEventListener('keydown', onKey);
      if (timer.current) clearTimeout(timer.current);
      restore();
    };
  }, []);

  if (!shown) return null;

  return createPortal(
    <div
      role="tooltip"
      className={`app-tooltip app-tooltip--${shown.side}`}
      style={{ top: shown.top, left: shown.left }}
    >
      <span className="app-tooltip-label">{shown.text}</span>
    </div>,
    document.body,
  );
}

export default TooltipHost;
