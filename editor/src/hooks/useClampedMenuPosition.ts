import { useLayoutEffect, useRef, useState } from 'react';
import { clampToViewport } from '../utils/clamp-to-viewport';

/**
 * Positions a cursor-anchored `position: fixed` menu so it always lands fully
 * on screen. Attach the returned ref to the menu element and spread the
 * returned `style` onto it.
 *
 * Measures the real rendered size in a layout effect (menu height depends on
 * how many conditional items are present), then flips/pins via
 * `clampToViewport` before the browser paints — so the menu never visibly
 * jumps from the unclamped position to the corrected one.
 */
export function useClampedMenuPosition(x: number, y: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { offsetWidth, offsetHeight } = el;
    setPos(
      clampToViewport({
        x,
        y,
        width: offsetWidth,
        height: offsetHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }),
    );
  }, [x, y]);

  return { ref, style: { left: pos.left, top: pos.top } };
}
