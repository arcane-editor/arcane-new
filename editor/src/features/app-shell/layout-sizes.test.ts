import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_SIDE_FRACTION,
  EDITOR_PANE_INDEX,
  MAX_SIDE_FRACTION,
  MIN_EDITOR_WIDTH,
  initialPaneSizes,
  resolveSideWidth,
  widthsForRestore,
} from './layout-sizes';

const W = 1600;

describe('resolveSideWidth', () => {
  it('uses a plausible persisted width verbatim', () => {
    expect(resolveSideWidth(420, W, DEFAULT_SIDE_FRACTION)).toBe(420);
  });

  it('rounds a fractional persisted width', () => {
    expect(resolveSideWidth(420.6, W, DEFAULT_SIDE_FRACTION)).toBe(421);
  });

  it('falls back to the fraction when nothing is persisted', () => {
    expect(resolveSideWidth(undefined, W, DEFAULT_SIDE_FRACTION)).toBe(480);
  });

  // Guards against leftovers from a bad layout reopening a pane absurdly wide.
  it('rejects garbage values', () => {
    expect(resolveSideWidth(0, W, DEFAULT_SIDE_FRACTION)).toBe(480);
    expect(resolveSideWidth(-10, W, DEFAULT_SIDE_FRACTION)).toBe(480);
    expect(resolveSideWidth(Number.NaN, W, DEFAULT_SIDE_FRACTION)).toBe(480);
    expect(resolveSideWidth(Number.POSITIVE_INFINITY, W, DEFAULT_SIDE_FRACTION)).toBe(480);
  });

  // The regression this raises the cap for: 45% used to discard a deliberately
  // wide sidebar on restart and snap back to 30%.
  it('honours a wide sidebar up to the cap', () => {
    expect(resolveSideWidth(W * 0.5, W, DEFAULT_SIDE_FRACTION)).toBe(800);
    expect(resolveSideWidth(W * MAX_SIDE_FRACTION, W, DEFAULT_SIDE_FRACTION)).toBe(1280);
  });

  it('rejects a width past the cap', () => {
    expect(resolveSideWidth(W * 0.9, W, DEFAULT_SIDE_FRACTION)).toBe(480);
  });
});

describe('initialPaneSizes', () => {
  it('gives each side the default fraction when nothing is persisted', () => {
    const { left, right, sizes } = initialPaneSizes({}, W);
    expect(left).toBe(480);
    expect(right).toBe(480);
    expect(sizes).toEqual([480, 640, 480]);
  });

  it('puts panes in [sidebar, editor, rightPanel] order', () => {
    const { sizes } = initialPaneSizes({ sidebar: 300, rightPanel: 500 }, W);
    expect(sizes).toEqual([300, 800, 500]);
    expect(sizes[EDITOR_PANE_INDEX]).toBe(800);
  });

  it('never lets the editor collapse below its floor', () => {
    const { sizes } = initialPaneSizes({ sidebar: 700, rightPanel: 700 }, 1000);
    expect(sizes[EDITOR_PANE_INDEX]).toBe(MIN_EDITOR_WIDTH);
  });
});

describe('widthsForRestore', () => {
  // Reopening the left sidebar at 400: the editor absorbs the difference and
  // the total stays pinned to the container width.
  it('reopens a pane at the given width, editor absorbing the change', () => {
    const next = widthsForRestore([0, 1120, 480], 0, 400, EDITOR_PANE_INDEX, MIN_EDITOR_WIDTH);
    expect(next).toEqual([400, 720, 480]);
    expect(next.reduce((a, b) => a + b, 0)).toBe(1600);
  });

  it('reopens the right pane the same way', () => {
    const next = widthsForRestore([480, 1120, 0], 2, 300, EDITOR_PANE_INDEX, MIN_EDITOR_WIDTH);
    expect(next).toEqual([480, 820, 300]);
    expect(next.reduce((a, b) => a + b, 0)).toBe(1600);
  });

  it('rounds a fractional width', () => {
    const next = widthsForRestore([0, 1120, 480], 0, 400.4, EDITOR_PANE_INDEX, MIN_EDITOR_WIDTH);
    expect(next[0]).toBe(400);
  });

  // A remembered width that no longer fits (window shrank, other pane grew)
  // must not squeeze the editor out of existence: the editor takes its floor
  // and the reopening pane gives way.
  it('clamps the reopening pane so the editor keeps its floor', () => {
    const next = widthsForRestore([0, 500, 300], 0, 400, EDITOR_PANE_INDEX, MIN_EDITOR_WIDTH);
    expect(next[EDITOR_PANE_INDEX]).toBe(MIN_EDITOR_WIDTH);
    expect(next).toEqual([180, 320, 300]);
    expect(next.reduce((a, b) => a + b, 0)).toBe(800);
  });

  // Beyond clamping: the other pane alone plus the editor floor already
  // overflows the container, so no arrangement fits. Floor the reopening pane
  // at 0 rather than going negative — Allotment's resizeViews clamps each
  // entry to the view's own [min, max] and re-runs layout, so an array that
  // over-sums is absorbed rather than fatal.
  it('floors at zero when no arrangement fits', () => {
    const next = widthsForRestore([0, 200, 600], 0, 500, EDITOR_PANE_INDEX, MIN_EDITOR_WIDTH);
    expect(next[0]).toBe(0);
    expect(next[EDITOR_PANE_INDEX]).toBe(MIN_EDITOR_WIDTH);
  });

  it('does not mutate the array it is given', () => {
    const current = [0, 1120, 480];
    widthsForRestore(current, 0, 400, EDITOR_PANE_INDEX, MIN_EDITOR_WIDTH);
    expect(current).toEqual([0, 1120, 480]);
  });
});
