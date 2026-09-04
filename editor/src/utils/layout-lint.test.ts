import { describe, it, expect } from 'bun:test';
import { lintLayout, parseColor, contrastRatio, type LintFinding, type Size } from './layout-lint';
import type { LayoutNode, LayoutProbeResult } from './layout-tree-text';

const PANEL: Size = { width: 800, height: 600 };

/** A `LayoutNode` with sane defaults, shaped like a node `HUD.uxml` would probe to. */
function node(over: Partial<LayoutNode>): LayoutNode {
  return {
    id: '0',
    parentId: null,
    name: null,
    kind: 'VisualElement',
    classes: [],
    depth: 0,
    box: { x: 0, y: 0, w: 100, h: 20 },
    styles: {},
    text: null,
    overflowX: false,
    ...over,
  };
}

function result(nodes: LayoutNode[]): LayoutProbeResult {
  return { nodes, truncated: false };
}

function codes(findings: LintFinding[]): string[] {
  return findings.map((f) => f.code);
}

describe('parseColor', () => {
  it('parses rgb() as opaque', () => {
    expect(parseColor('rgb(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 });
  });

  it('parses rgba() with its own alpha', () => {
    expect(parseColor('rgba(1, 2, 3, 0.5)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
  });

  it('returns null for an unparsable value', () => {
    expect(parseColor('transparent')).toBeNull();
    expect(parseColor(undefined)).toBeNull();
    expect(parseColor('')).toBeNull();
  });
});

describe('contrastRatio', () => {
  it('is 21:1 for pure black on pure white', () => {
    const white = { r: 255, g: 255, b: 255, a: 1 };
    const black = { r: 0, g: 0, b: 0, a: 1 };
    expect(contrastRatio(white, black)).toBeCloseTo(21, 0);
  });

  it('is 1:1 for identical colours', () => {
    const c = { r: 128, g: 128, b: 128, a: 1 };
    expect(contrastRatio(c, c)).toBeCloseTo(1, 5);
  });

  it('is symmetric', () => {
    const a = { r: 200, g: 50, b: 10, a: 1 };
    const b = { r: 10, g: 20, b: 30, a: 1 };
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
  });
});

describe('lintLayout — offscreen', () => {
  it('flags an element entirely outside the panel', () => {
    const findings = lintLayout(result([node({ name: 'x', box: { x: -200, y: 0, w: 50, h: 20 } })]), PANEL);
    expect(codes(findings)).toEqual(['offscreen']);
    expect(findings[0].severity).toBe('warn');
  });

  it('does not flag an element that is only partially clipped', () => {
    const findings = lintLayout(
      result([node({ name: 'x', box: { x: PANEL.width - 10, y: 0, w: 50, h: 20 } })]),
      PANEL,
    );
    expect(findings).toEqual([]);
  });

  it('does not flag an element fully inside the panel', () => {
    const findings = lintLayout(result([node({ name: 'x', box: { x: 10, y: 10, w: 50, h: 20 } })]), PANEL);
    expect(findings).toEqual([]);
  });
});

describe('lintLayout — zero-size with content', () => {
  it('flags zero width with text', () => {
    const findings = lintLayout(
      result([node({ name: 'hp-label', text: 'HP', box: { x: 10, y: 10, w: 0, h: 20 } })]),
      PANEL,
    );
    expect(codes(findings)).toEqual(['zero-size']);
    expect(findings[0].severity).toBe('error');
    expect(findings[0].message).toContain('width');
  });

  it('flags zero height with a child', () => {
    const findings = lintLayout(
      result([
        node({ id: 'p', name: 'wrap', box: { x: 0, y: 0, w: 100, h: 0 } }),
        node({ id: 'c', parentId: 'p', name: 'child', depth: 1 }),
      ]),
      PANEL,
    );
    const zero = findings.filter((f) => f.code === 'zero-size');
    expect(zero).toHaveLength(1);
    expect(zero[0].node.name).toBe('wrap');
    expect(zero[0].message).toContain('height');
  });

  it('does not flag an empty zero-size container with no text and no children', () => {
    const findings = lintLayout(result([node({ name: 'spacer', box: { x: 10, y: 10, w: 0, h: 0 } })]), PANEL);
    expect(findings).toEqual([]);
  });

  it('does not flag a normally-sized element with text', () => {
    const findings = lintLayout(result([node({ name: 'hp-label', text: 'HP' })]), PANEL);
    expect(findings).toEqual([]);
  });
});

describe('lintLayout — clipped text', () => {
  it('flags overflowing text', () => {
    const findings = lintLayout(
      result([node({ name: 'label', text: 'a very long label that does not fit', overflowX: true })]),
      PANEL,
    );
    expect(codes(findings)).toEqual(['clipped-text']);
    expect(findings[0].severity).toBe('warn');
  });

  it('does not flag overflowX with no text', () => {
    const findings = lintLayout(result([node({ name: 'wrap', overflowX: true, text: null })]), PANEL);
    expect(findings).toEqual([]);
  });

  it('does not flag text that fits', () => {
    const findings = lintLayout(result([node({ name: 'label', text: 'HP', overflowX: false })]), PANEL);
    expect(findings).toEqual([]);
  });
});

describe('lintLayout — contrast', () => {
  it('flags near-black text against the default stage background', () => {
    const findings = lintLayout(
      result([node({ name: 'label', text: 'HP', styles: { color: 'rgb(20, 18, 24)' } })]),
      PANEL,
    );
    expect(codes(findings)).toContain('low-contrast');
    expect(findings.find((f) => f.code === 'low-contrast')!.severity).toBe('error');
  });

  it('does not flag white text against the default (dark) stage background', () => {
    const findings = lintLayout(
      result([node({ name: 'label', text: 'HP', styles: { color: 'rgb(255, 255, 255)' } })]),
      PANEL,
    );
    expect(codes(findings)).not.toContain('low-contrast');
  });

  it('uses the nearest ancestor background with alpha > 0, not the default stage colour', () => {
    const findings = lintLayout(
      result([
        node({ id: 'p', name: 'panel', styles: { backgroundColor: 'rgb(255, 255, 255)' } }),
        node({
          id: 'c',
          parentId: 'p',
          name: 'label',
          depth: 1,
          text: 'HP',
          styles: { color: 'rgb(245, 245, 245)' },
        }),
      ]),
      PANEL,
    );
    // Near-white text on a white background is unreadable even though the
    // default stage colour (near-black) would have passed easily.
    expect(codes(findings)).toContain('low-contrast');
  });

  it('skips a fully transparent ancestor background and keeps walking up', () => {
    const findings = lintLayout(
      result([
        node({ id: 'grandparent', name: 'root', styles: { backgroundColor: 'rgb(255, 255, 255)' } }),
        node({
          id: 'p',
          parentId: 'grandparent',
          name: 'overlay',
          depth: 1,
          styles: { backgroundColor: 'rgba(0, 0, 0, 0)' },
        }),
        node({
          id: 'c',
          parentId: 'p',
          name: 'label',
          depth: 2,
          text: 'HP',
          styles: { color: 'rgb(245, 245, 245)' },
        }),
      ]),
      PANEL,
    );
    // Text colour is near-white; the transparent overlay must be skipped so the
    // white grandparent (also low contrast) is what gets compared against.
    expect(codes(findings)).toContain('low-contrast');
  });

  it('does not flag a node with no text', () => {
    const findings = lintLayout(result([node({ name: 'wrap', styles: { color: 'rgb(0,0,0)' } })]), PANEL);
    expect(findings).toEqual([]);
  });

  it('does not flag a node whose color is unparsable', () => {
    const findings = lintLayout(
      result([node({ name: 'label', text: 'HP', styles: { color: 'currentColor' } })]),
      PANEL,
    );
    expect(findings).toEqual([]);
  });
});

describe('lintLayout — overlapping absolute siblings', () => {
  it('flags two overlapping position:absolute siblings under the same parent', () => {
    const findings = lintLayout(
      result([
        node({ id: 'p', name: 'root' }),
        node({
          id: 'a',
          parentId: 'p',
          name: 'a',
          depth: 1,
          styles: { position: 'absolute' },
          box: { x: 0, y: 0, w: 100, h: 100 },
        }),
        node({
          id: 'b',
          parentId: 'p',
          name: 'b',
          depth: 1,
          styles: { position: 'absolute' },
          box: { x: 50, y: 50, w: 100, h: 100 },
        }),
      ]),
      PANEL,
    );
    expect(codes(findings)).toEqual(['overlap']);
    expect(findings[0].node.name).toBe('b');
  });

  it('does not flag absolute siblings that do not overlap', () => {
    const findings = lintLayout(
      result([
        node({ id: 'p', name: 'root' }),
        node({
          id: 'a',
          parentId: 'p',
          name: 'a',
          depth: 1,
          styles: { position: 'absolute' },
          box: { x: 0, y: 0, w: 50, h: 50 },
        }),
        node({
          id: 'b',
          parentId: 'p',
          name: 'b',
          depth: 1,
          styles: { position: 'absolute' },
          box: { x: 200, y: 200, w: 50, h: 50 },
        }),
      ]),
      PANEL,
    );
    expect(findings).toEqual([]);
  });

  it('does not flag overlapping siblings that are not position:absolute', () => {
    const findings = lintLayout(
      result([
        node({ id: 'p', name: 'root' }),
        node({ id: 'a', parentId: 'p', name: 'a', depth: 1, box: { x: 0, y: 0, w: 100, h: 100 } }),
        node({ id: 'b', parentId: 'p', name: 'b', depth: 1, box: { x: 50, y: 50, w: 100, h: 100 } }),
      ]),
      PANEL,
    );
    expect(findings).toEqual([]);
  });

  it('does not flag overlapping absolute nodes under different parents', () => {
    const findings = lintLayout(
      result([
        node({
          id: 'a',
          parentId: 'p1',
          name: 'a',
          styles: { position: 'absolute' },
          box: { x: 0, y: 0, w: 100, h: 100 },
        }),
        node({
          id: 'b',
          parentId: 'p2',
          name: 'b',
          styles: { position: 'absolute' },
          box: { x: 50, y: 50, w: 100, h: 100 },
        }),
      ]),
      PANEL,
    );
    expect(findings).toEqual([]);
  });
});

describe('lintLayout — button too small', () => {
  it('flags a Button under 32px tall', () => {
    const findings = lintLayout(
      result([node({ name: 'pause-button', kind: 'Button', box: { x: 0, y: 0, w: 40, h: 20 } })]),
      PANEL,
    );
    expect(codes(findings)).toEqual(['button-too-small']);
    expect(findings[0].severity).toBe('warn');
  });

  it('does not flag a Button at or above 32px', () => {
    const findings = lintLayout(
      result([node({ name: 'pause-button', kind: 'Button', box: { x: 0, y: 0, w: 40, h: 32 } })]),
      PANEL,
    );
    expect(findings).toEqual([]);
  });

  it('does not flag a non-Button element under 32px tall', () => {
    const findings = lintLayout(
      result([node({ name: 'hp-bar', kind: 'ProgressBar', box: { x: 0, y: 0, w: 40, h: 8 } })]),
      PANEL,
    );
    expect(findings).toEqual([]);
  });
});

describe('lintLayout — HUD edge', () => {
  it('flags a HUD-named element within 16px of the panel edge', () => {
    const findings = lintLayout(
      result([node({ name: 'hud-corner', box: { x: 5, y: 100, w: 40, h: 40 } })]),
      PANEL,
    );
    expect(codes(findings)).toEqual(['hud-edge']);
    expect(findings[0].message).toContain('left');
  });

  it('matches on class as well as name, case-insensitively', () => {
    const findings = lintLayout(
      result([node({ name: 'corner', classes: ['HUD__panel'], box: { x: 5, y: 100, w: 40, h: 40 } })]),
      PANEL,
    );
    expect(codes(findings)).toEqual(['hud-edge']);
  });

  it('does not flag a HUD element safely inside the margin', () => {
    const findings = lintLayout(
      result([node({ name: 'hud-corner', box: { x: 100, y: 100, w: 40, h: 40 } })]),
      PANEL,
    );
    expect(findings).toEqual([]);
  });

  it('does not flag a non-HUD element near the edge', () => {
    const findings = lintLayout(result([node({ name: 'corner', box: { x: 5, y: 100, w: 40, h: 40 } })]), PANEL);
    expect(findings).toEqual([]);
  });

  it('defers to the offscreen finding rather than double-reporting a HUD element that is fully off-panel', () => {
    const findings = lintLayout(
      result([node({ name: 'hud-corner', box: { x: -100, y: 100, w: 40, h: 40 } })]),
      PANEL,
    );
    expect(codes(findings)).toEqual(['offscreen']);
  });
});

describe('lintLayout — combined', () => {
  it('runs every rule and reports every kind of finding a HUD-shaped fixture triggers', () => {
    const findings = lintLayout(
      result([
        node({ id: 'root', name: 'hud-root', classes: ['hud'], box: { x: 0, y: 0, w: 800, h: 600 } }),
        node({
          id: 'off',
          parentId: 'root',
          name: 'minimap',
          depth: 1,
          box: { x: -900, y: 0, w: 50, h: 50 },
        }),
        node({
          id: 'zero',
          parentId: 'root',
          name: 'ammo-count',
          depth: 1,
          text: '0',
          box: { x: 10, y: 10, w: 0, h: 20 },
        }),
        node({
          id: 'clipped',
          parentId: 'root',
          name: 'kill-feed',
          depth: 1,
          text: 'Player eliminated Bot',
          overflowX: true,
          box: { x: 10, y: 40, w: 60, h: 20 },
        }),
        node({
          id: 'contrast',
          parentId: 'root',
          name: 'score',
          depth: 1,
          text: '100',
          styles: { color: 'rgb(25, 20, 30)' },
          box: { x: 10, y: 70, w: 60, h: 20 },
        }),
        node({
          id: 'button',
          parentId: 'root',
          name: 'pause-button',
          kind: 'Button',
          depth: 1,
          box: { x: 10, y: 100, w: 40, h: 18 },
        }),
        node({
          id: 'hud-edge',
          parentId: 'root',
          name: 'hud-toast',
          depth: 1,
          box: { x: 796, y: 300, w: 20, h: 20 },
        }),
      ]),
      PANEL,
    );
    expect(new Set(codes(findings))).toEqual(
      new Set(['offscreen', 'zero-size', 'clipped-text', 'low-contrast', 'button-too-small', 'hud-edge']),
    );
  });
});
