// The facts block is frozen per conversation (frozen-context.ts) and re-sent
// on every turn, so `uiDesignFactLines` output must be deterministic (same
// input -> byte-identical output, no dates/counts that drift) and budgeted
// the same way `input-facts.ts`/`subsystem-facts.ts` are: the fixed design
// rules are reserved out of the budget first, so it is always the per-project
// variable/panel listing that shrinks on a large project, never the rules.

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  uiDesignFactLines,
  collectUssVariables,
  DESIGN_RULES,
  type UiDesignFacts,
  type UssSheetDeclarations,
} from './ui-design-facts';
import { HUD_EDGE_MARGIN } from '../../../../utils/layout-lint';

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

  // Fix round 1, F1: `panelsLines`' "always show the first panel" rule and
  // its "(+K more)" tail had no direct coverage.
  describe('budget behavior (fix round 1, F1)', () => {
    const threePanels: UiDesignFacts = {
      variables: [],
      themeSheets: [],
      stack: 'uitoolkit',
      panels: [
        { ...ONE_PANEL.panels[0], name: 'Zebra', path: 'Assets/UI/Zebra.asset' },
        { ...ONE_PANEL.panels[0], name: 'Middle', path: 'Assets/UI/Middle.asset' },
        { ...ONE_PANEL.panels[0], name: 'Ampersand', path: 'Assets/UI/Ampersand.asset' },
      ],
    };

    it('keeps the first (path-sorted) panel even when the budget is too small for even one line', () => {
      // budget: 1 leaves ~0 chars for the variable/panel section once the
      // fixed design rules are reserved out of it first.
      const lines = uiDesignFactLines(threePanels, 1);
      expect(lines).toContain(
        '- Panel: Ampersand — ScaleWithScreenSize, reference 1920×1080 (match width). Lay out in those pixels.',
      );
    });

    it('drops the rest and reports exactly how many were not shown', () => {
      const lines = uiDesignFactLines(threePanels, 1);
      expect(lines).toContain('- Panel: (+2 more not shown — call unity_ui_toolkit for the rest).');
      // Only the kept panel and the tail line — Middle/Zebra never render.
      expect(lines.filter((l) => l.startsWith('- Panel:'))).toHaveLength(2);
      expect(lines.join('\n')).not.toContain('Middle');
      expect(lines.join('\n')).not.toContain('Zebra');
    });

    it('reports the correct count for a different number of dropped panels', () => {
      const fivePanels: UiDesignFacts = {
        ...threePanels,
        panels: [
          ...threePanels.panels,
          { ...ONE_PANEL.panels[0], name: 'Delta', path: 'Assets/UI/Delta.asset' },
          { ...ONE_PANEL.panels[0], name: 'Echo', path: 'Assets/UI/Echo.asset' },
        ],
      };
      const lines = uiDesignFactLines(fivePanels, 1);
      expect(lines).toContain('- Panel: (+4 more not shown — call unity_ui_toolkit for the rest).');
    });

    it('emits a single panel in full even when it alone exceeds the budget, with no "more" tail', () => {
      const lines = uiDesignFactLines(ONE_PANEL, 1);
      expect(lines).toContain(
        '- Panel: GamePanel — ScaleWithScreenSize, reference 1920×1080 (match width). Lay out in those pixels.',
      );
      expect(lines.some((l) => l.includes('more not shown'))).toBe(false);
      expect(lines.filter((l) => l.startsWith('- Panel:'))).toHaveLength(1);
    });

    it('shows every panel, no tail, when the budget is generous enough for all of them', () => {
      const lines = uiDesignFactLines(threePanels, 3000);
      expect(lines.filter((l) => l.startsWith('- Panel:'))).toHaveLength(3);
      expect(lines.some((l) => l.includes('more not shown'))).toBe(false);
    });
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

  it('derives variables/themeSheets via the shared pure collectUssVariables, not an inline dedup', () => {
    expect(src).toContain('collectUssVariables(sheets)');
    expect(src).not.toContain('sheetOfVar');
  });
});

// Fix round 1, F2: the USS-variable dedup ("first sheet wins" in path-sorted
// order) and `themeSheets` derivation used to live inline inside
// `readUiToolkitFacts` (unity-facts.ts), which is not Bun-importable — the
// only coverage was source-string pins. Extracted to `collectUssVariables`
// (ui-design-facts.ts, pure) so it is testable directly.
describe('collectUssVariables', () => {
  it('resolves a variable declared in two sheets to the path-sorted FIRST sheet, not the last', () => {
    const sheets: UssSheetDeclarations[] = [
      { path: 'Assets/UI/Zebra.uss', declarations: [{ property: '--color-bg', value: '#000000' }] },
      { path: 'Assets/UI/Ampersand.uss', declarations: [{ property: '--color-bg', value: '#1b1726' }] },
    ];
    const { variables } = collectUssVariables(sheets);
    expect(variables).toEqual([{ name: '--color-bg', value: '#1b1726', sheet: 'Ampersand.uss' }]);
  });

  it('is deterministic regardless of the input order of sheets', () => {
    const a: UssSheetDeclarations = {
      path: 'Assets/UI/Ampersand.uss',
      declarations: [{ property: '--color-bg', value: '#1b1726' }],
    };
    const z: UssSheetDeclarations = {
      path: 'Assets/UI/Zebra.uss',
      declarations: [{ property: '--color-bg', value: '#000000' }],
    };
    expect(collectUssVariables([a, z])).toEqual(collectUssVariables([z, a]));
  });

  it('ignores declarations whose property is not a custom property (does not start with --)', () => {
    const sheets: UssSheetDeclarations[] = [
      {
        path: 'Assets/UI/Theme.uss',
        declarations: [
          { property: 'background-color', value: '#1b1726' },
          { property: '--color-bg', value: '#1b1726' },
        ],
      },
    ];
    const { variables } = collectUssVariables(sheets);
    expect(variables).toEqual([{ name: '--color-bg', value: '#1b1726', sheet: 'Theme.uss' }]);
  });

  it('keeps the first declaration of a repeated variable WITHIN one sheet too', () => {
    const sheets: UssSheetDeclarations[] = [
      {
        path: 'Assets/UI/Theme.uss',
        declarations: [
          { property: '--color-bg', value: '#1b1726' },
          { property: '--color-bg', value: '#ffffff' },
        ],
      },
    ];
    const { variables } = collectUssVariables(sheets);
    expect(variables).toEqual([{ name: '--color-bg', value: '#1b1726', sheet: 'Theme.uss' }]);
  });

  it('themeSheets lists exactly the sheets that declare at least one variable, sorted, deduped', () => {
    const sheets: UssSheetDeclarations[] = [
      { path: 'Assets/UI/Zebra.uss', declarations: [{ property: '--radius-sm', value: '4px' }] },
      { path: 'Assets/UI/Ampersand.uss', declarations: [{ property: '--color-bg', value: '#1b1726' }] },
      // Declares no custom property at all — must not appear in themeSheets.
      { path: 'Assets/UI/Layout.uss', declarations: [{ property: 'flex-grow', value: '1' }] },
      // Same basename as Ampersand's sheet, different path — themeSheets is
      // deduped by basename, not by full path.
      { path: 'Assets/Other/Ampersand.uss', declarations: [{ property: '--spacing-md', value: '8px' }] },
    ];
    const { themeSheets } = collectUssVariables(sheets);
    expect(themeSheets).toEqual(['Ampersand.uss', 'Zebra.uss']);
  });

  it('returns empty variables/themeSheets for no sheets and for sheets with no custom properties', () => {
    expect(collectUssVariables([])).toEqual({ variables: [], themeSheets: [] });
    expect(
      collectUssVariables([{ path: 'Assets/UI/Layout.uss', declarations: [{ property: 'flex-grow', value: '1' }] }]),
    ).toEqual({ variables: [], themeSheets: [] });
  });
});

// M7. The prompt states the design rules and `unity_ui_layout`'s lint enforces
// them, so a number that appears in both has to BE the same number. It was
// not: the prompt asked for a 24px HUD safe area while the lint only complained
// below 16, and a HUD at 20px therefore broke the stated rule and passed the
// check that exists to catch it.
describe('the stated design rules match the lint that enforces them', () => {
  it('states the HUD safe area as exactly the margin layout-lint uses', () => {
    const rule = DESIGN_RULES.find((r) => r.includes('HUD safe area'));
    expect(rule).toBeDefined();
    expect(rule).toBe(`- HUD safe area ≥ ${HUD_EDGE_MARGIN}px from every edge.`);
  });
});
