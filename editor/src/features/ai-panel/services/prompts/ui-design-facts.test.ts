// The facts block is frozen per conversation (frozen-context.ts) and re-sent
// on every turn, so `uiDesignFactLines` output must be deterministic (same
// input -> byte-identical output, no dates/counts that drift) and budgeted
// the same way `input-facts.ts`/`subsystem-facts.ts` are: the fixed design
// rules are reserved out of the budget first, so it is always the per-project
// variable/panel listing that shrinks on a large project, never the rules.

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { uiDesignFactLines, type UiDesignFacts } from './ui-design-facts';

const EMPTY: UiDesignFacts = { variables: [], panels: [], themeSheets: [], stack: 'uitoolkit' };

const ONE_VAR: UiDesignFacts = {
  variables: [{ name: '--color-bg', value: '#1b1726', sheet: 'Theme.uss' }],
  panels: [],
  themeSheets: ['Theme.uss'],
  stack: 'uitoolkit',
};

const ONE_PANEL: UiDesignFacts = {
  variables: [],
  panels: [
    {
      name: 'GamePanel',
      path: 'Assets/UI/GamePanel.asset',
      scaleMode: 'scale-with-screen',
      referenceResolution: { w: 1920, h: 1080 },
      screenMatchMode: 'match-width-or-height',
      match: 0,
    },
  ],
  themeSheets: [],
  stack: 'uitoolkit',
};

describe('uiDesignFactLines — determinism', () => {
  it('is byte-stable for equal input', () => {
    const a = uiDesignFactLines(ONE_VAR);
    const b = uiDesignFactLines({
      variables: [{ name: '--color-bg', value: '#1b1726', sheet: 'Theme.uss' }],
      panels: [],
      themeSheets: ['Theme.uss'],
      stack: 'uitoolkit',
    });
    expect(a).toEqual(b);
    expect(a.join('\n')).toBe(b.join('\n'));
  });

  it('carries no dates, counts-that-drift, or other volatile content', () => {
    const out = uiDesignFactLines(ONE_VAR).join('\n');
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe('uiDesignFactLines — the fixed design rules always appear in full', () => {
  it('includes all twelve rule lines verbatim, unaffected by a tiny budget', () => {
    const out = uiDesignFactLines(EMPTY, 1).join('\n');
    for (const rule of [
      'Spacing scale: 4/8/12/16/24/32px only.',
      'Type scale: 12/14/16/20/24/32px at the reference resolution.',
      'Text contrast ≥ 4.5:1.',
      'Flex only',
      'flex-grow:1',
      'HUD safe area ≥ 24px',
      'position:absolute',
      ':hover`/`:active`/`:focus`/`:disabled`',
      'transition-property',
      '-unity-text-align',
      'gets a `name`',
      'border-radius',
    ]) {
      expect(out).toContain(rule);
    }
  });
});

describe('uiDesignFactLines — no variables', () => {
  it('states none are declared and tells the model what to do about it', () => {
    const out = uiDesignFactLines(EMPTY).join('\n');
    expect(out).toContain(
      '- USS variables: none declared — define a small set (colors, spacing, radius) in a theme .uss and reference them with var(), not new literals.',
    );
  });
});

describe('uiDesignFactLines — variables', () => {
  it('names count, source sheet(s), and each --name/value pair', () => {
    const out = uiDesignFactLines(ONE_VAR).join('\n');
    expect(out).toContain('- USS variables (1, from Theme.uss): --color-bg #1b1726');
    expect(out).toContain('reference these with var(), not new literals.');
  });

  it('sorts variables by name regardless of input order', () => {
    const facts: UiDesignFacts = {
      variables: [
        { name: '--spacing-md', value: '8px', sheet: 'Theme.uss' },
        { name: '--color-bg', value: '#1b1726', sheet: 'Theme.uss' },
        { name: '--color-fg', value: '#eeeeee', sheet: 'Theme.uss' },
      ],
      panels: [],
      themeSheets: ['Theme.uss'],
      stack: 'uitoolkit',
    };
    const out = uiDesignFactLines(facts, 900).join('\n');
    const line = out.split('\n').find((l) => l.startsWith('- USS variables'))!;
    const iBg = line.indexOf('--color-bg');
    const iFg = line.indexOf('--color-fg');
    const iSp = line.indexOf('--spacing-md');
    expect(iBg).toBeGreaterThan(-1);
    expect(iBg).toBeLessThan(iFg);
    expect(iFg).toBeLessThan(iSp);
  });

  it('lists multiple theme sheets, sorted', () => {
    const facts: UiDesignFacts = {
      variables: [
        { name: '--color-bg', value: '#111', sheet: 'Zebra.uss' },
        { name: '--radius-sm', value: '4px', sheet: 'Ampersand.uss' },
      ],
      panels: [],
      themeSheets: ['Zebra.uss', 'Ampersand.uss'],
      stack: 'uitoolkit',
    };
    const out = uiDesignFactLines(facts).join('\n');
    expect(out).toContain('from Ampersand.uss, Zebra.uss');
  });

  it('trims a long declared value to 24 characters', () => {
    const longValue = 'linear-gradient(to bottom, red, blue, green, yellow)'; // > 24 chars
    const facts: UiDesignFacts = {
      variables: [{ name: '--bg-gradient', value: longValue, sheet: 'Theme.uss' }],
      panels: [],
      themeSheets: ['Theme.uss'],
      stack: 'uitoolkit',
    };
    const out = uiDesignFactLines(facts).join('\n');
    expect(out).toContain(longValue.slice(0, 24));
    expect(out).not.toContain(longValue);
  });

  it('truncates the variable list to fit the budget, saying how many were dropped', () => {
    const many: UiDesignFacts = {
      variables: Array.from({ length: 60 }, (_, i) => ({
        name: `--token-${String(i).padStart(2, '0')}`,
        value: `#${(i * 111111).toString(16).padStart(6, '0').slice(0, 6)}`,
        sheet: 'Theme.uss',
      })),
      panels: [],
      themeSheets: ['Theme.uss'],
      stack: 'uitoolkit',
    };
    const out = uiDesignFactLines(many, 900).join('\n');
    expect(out).toContain('more)');
    // Never balloons past a small multiple of the nominal budget.
    expect(out.length).toBeLessThan(1800);
  });
});

describe('uiDesignFactLines — no panels', () => {
  it('says none were found and gives a safe default to lay out against', () => {
    const out = uiDesignFactLines(EMPTY).join('\n');
    expect(out).toContain(
      '- Panel: none found — lay out at 1920×1080 and create PanelSettings when wiring (unity_attach_ui_document does it).',
    );
  });
});

describe('uiDesignFactLines — panels', () => {
  it('names the panel, scale mode, reference resolution, and match direction', () => {
    const out = uiDesignFactLines(ONE_PANEL).join('\n');
    expect(out).toContain(
      '- Panel: GamePanel — ScaleWithScreenSize, reference 1920×1080 (match width). Lay out in those pixels.',
    );
  });

  it('renders "match height" for match: 1 and "match <value>" for a blended match', () => {
    const height: UiDesignFacts = {
      ...ONE_PANEL,
      panels: [{ ...ONE_PANEL.panels[0], match: 1 }],
    };
    const blended: UiDesignFacts = {
      ...ONE_PANEL,
      panels: [{ ...ONE_PANEL.panels[0], match: 0.5 }],
    };
    expect(uiDesignFactLines(height).join('\n')).toContain('(match height)');
    expect(uiDesignFactLines(blended).join('\n')).toContain('(match 0.5)');
  });

  it('omits the match parenthetical for shrink/expand match modes', () => {
    const shrink: UiDesignFacts = {
      ...ONE_PANEL,
      panels: [{ ...ONE_PANEL.panels[0], screenMatchMode: 'shrink' }],
    };
    const out = uiDesignFactLines(shrink).join('\n');
    expect(out).toContain('reference 1920×1080. Lay out in those pixels.');
    expect(out).not.toContain('match');
  });

  it('omits the reference clause entirely when there is none to report', () => {
    const noRef: UiDesignFacts = {
      ...ONE_PANEL,
      panels: [{ ...ONE_PANEL.panels[0], referenceResolution: null }],
    };
    const lines = uiDesignFactLines(noRef);
    const panelLine = lines.find((l) => l.startsWith('- Panel:'))!;
    expect(panelLine).toBe('- Panel: GamePanel — ScaleWithScreenSize. Lay out in those pixels.');
  });

  it('labels constant-pixel and constant-physical scale modes', () => {
    const pixel: UiDesignFacts = {
      ...ONE_PANEL,
      panels: [{ ...ONE_PANEL.panels[0], scaleMode: 'constant-pixel', referenceResolution: null }],
    };
    const physical: UiDesignFacts = {
      ...ONE_PANEL,
      panels: [{ ...ONE_PANEL.panels[0], scaleMode: 'constant-physical', referenceResolution: null }],
    };
    expect(uiDesignFactLines(pixel).join('\n')).toContain('ConstantPixelSize');
    expect(uiDesignFactLines(physical).join('\n')).toContain('ConstantPhysicalSize');
  });

  it('sorts multiple panels by path regardless of input order', () => {
    const facts: UiDesignFacts = {
      variables: [],
      themeSheets: [],
      stack: 'uitoolkit',
      panels: [
        { ...ONE_PANEL.panels[0], name: 'Zebra', path: 'Assets/UI/Zebra.asset' },
        { ...ONE_PANEL.panels[0], name: 'Ampersand', path: 'Assets/UI/Ampersand.asset' },
      ],
    };
    // A generous budget so sort order is what's under test, not truncation.
    const out = uiDesignFactLines(facts, 2000).join('\n');
    const iA = out.indexOf('Ampersand');
    const iZ = out.indexOf('Zebra');
    expect(iA).toBeGreaterThan(-1);
    expect(iZ).toBeGreaterThan(-1);
    expect(iA).toBeLessThan(iZ);
  });
});

describe('uiDesignFactLines — mixed stack caution', () => {
  it('warns when the project also has uGUI, and says nothing extra otherwise', () => {
    const both = uiDesignFactLines({ ...EMPTY, stack: 'both' }).join('\n');
    expect(both).toContain('also uses uGUI (Canvas)');

    const pure = uiDesignFactLines({ ...EMPTY, stack: 'uitoolkit' }).join('\n');
    expect(pure).not.toContain('uGUI');
  });
});

// `unity-facts.ts` statically imports `stores/workspace.ts` etc. (Bun-unsafe —
// same constraint every other test file next to it documents), so its wiring
// of `uiDesign` cannot be exercised by importing the module under Bun. A
// source-text assertion is the same technique `prompts.test.ts` uses for
// `index.ts`'s mode-to-prompt wiring, and is exactly as precise: it fails the
// instant any of these three wires comes apart.
describe('unity-facts.ts wiring (source pin — Bun cannot import the module itself)', () => {
  const src = readFileSync(
    path.resolve(import.meta.dir, './unity-facts.ts'),
    'utf8',
  );

  it('declares UnityFacts.uiDesign as UiDesignFacts | null', () => {
    expect(src).toContain('uiDesign: UiDesignFacts | null;');
  });

  it('populates uiDesign in the cache alongside uiStack, from the analyzers + panel scan', () => {
    expect(src).toMatch(/uiDesign:\s*UiDesignFacts \| null\s*=\s*ui\s*\?/);
    expect(src).toContain('uiDesign,');
  });

  it('getUnityFactsBlock appends uiDesignFactLines only when uiToolkit is selected', () => {
    expect(src).toMatch(
      /selected\.includes\('uiToolkit'\) && facts\.uiDesign\)\s*\{\s*\n\s*lines\.push\(\.\.\.uiDesignFactLines\(facts\.uiDesign\)\);/,
    );
  });

  it('gathers PanelSettings size-gated (stat every candidate before reading any of them)', () => {
    expect(src).toContain('file_sizes_bulk');
    expect(src).toContain('MAX_PANEL_ASSET_BYTES');
    expect(src).toContain('parsePanelSettings');
  });
});
