import { describe, it, expect } from 'bun:test';
import { DRAG_THRESHOLD_PX, exceedsDragThreshold, zoneIdOf } from './pointer-drag';

describe('exceedsDragThreshold', () => {
  /**
   * A drag must not start on a click. Tabs are click-to-activate and tree rows
   * are click-to-open, so the few pixels of travel during an ordinary click
   * have to stay a click.
   */
  it('ignores movement below the threshold', () => {
    expect(exceedsDragThreshold(0, 0)).toBe(false);
    expect(exceedsDragThreshold(DRAG_THRESHOLD_PX - 1, 0)).toBe(false);
    expect(exceedsDragThreshold(0, -(DRAG_THRESHOLD_PX - 1))).toBe(false);
  });

  it('starts on travel in any direction', () => {
    expect(exceedsDragThreshold(DRAG_THRESHOLD_PX, 0)).toBe(true);
    expect(exceedsDragThreshold(0, DRAG_THRESHOLD_PX)).toBe(true);
    expect(exceedsDragThreshold(-DRAG_THRESHOLD_PX, 0)).toBe(true);
  });

  it('uses distance, not per-axis travel, so a diagonal drag still starts', () => {
    const d = DRAG_THRESHOLD_PX * 0.75; // under the threshold on either axis alone
    expect(exceedsDragThreshold(d, d)).toBe(true);
  });
});

describe('zoneIdOf', () => {
  /** Minimal Element stand-in — only what the walk actually reads. */
  function el(zone: string | null, parent: unknown = null) {
    return {
      getAttribute: (n: string) => (n === 'data-drop-zone' ? zone : null),
      parentElement: parent,
    } as unknown as HTMLElement;
  }

  it('finds the zone on the element itself', () => {
    expect(zoneIdOf(el('ai-panel'))).toBe('ai-panel');
  });

  it('walks up to the nearest enclosing zone', () => {
    // The pointer is over a button inside the panel, not the panel element.
    expect(zoneIdOf(el(null, el(null, el('ai-panel'))))).toBe('ai-panel');
  });

  it('returns the INNERMOST zone when zones nest', () => {
    // A tab inside the tab strip: the tab wins, so a drop reorders rather than
    // falling through to whatever the strip would do.
    expect(zoneIdOf(el('tab', el('tab-strip')))).toBe('tab');
  });

  it('returns null outside any zone', () => {
    expect(zoneIdOf(el(null, el(null)))).toBeNull();
    expect(zoneIdOf(null)).toBeNull();
  });
});
