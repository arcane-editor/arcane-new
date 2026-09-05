// `unity_ui_layout` has no real DOM to probe under Bun (`layout-probe.ts` is
// reached only through a dynamic `import()` of the `uitoolkit` barrel, which
// this suite never touches — see Global Constraint 4). Every test here
// injects `probe`, `loadStyleSheets` and `loadPanelSettings` instead, and
// exercises the tool's own logic: panel-confidence resolution, tree/lint
// rendering glue, notes, truncation, and the Task 14 GUID-verification tail.

import { describe, it, expect, afterEach } from 'bun:test';
import { createUnityUiLayoutTool, type UiLayoutToolDeps } from './ui-layout-tool';
import { registerPendingGuidCheck, resetPendingGuidChecks } from './guid-verify';
import type { LoadedStyles, PanelResolution, ProbeLayoutOutput } from '../../../uitoolkit';
import type { LayoutNode } from '../../../../utils/layout-tree-text';

const WS = '/proj';
const DOC = 'Assets/UI/HUD.uxml';
const ABS = `${WS}/${DOC}`;

const HUD = `<ui:UXML xmlns:ui="UnityEngine.UIElements">
  <ui:VisualElement name="hud-root" class="hud">
    <ui:Label name="hp-label" text="HP" class="hud__label" />
  </ui:VisualElement>
</ui:UXML>`;

/** A `PanelSettings` YAML asset, shaped like `panel-settings.test.ts`'s fixture. */
function panelAsset(name: string, referenceWidth = 1200, referenceHeight = 800): string {
  return `%YAML 1.1
--- !u!114 &11400000
MonoBehaviour:
  m_Name: ${name}
  m_EditorClassIdentifier: UnityEngine.dll::UnityEngine.UIElements.PanelSettings
  m_ScaleMode: 0
  m_Scale: 1
  m_ReferenceDpi: 96
  m_FallbackDpi: 96
  m_ReferenceResolution: {x: ${referenceWidth}, y: ${referenceHeight}}
  m_ScreenMatchMode: 0
  m_Match: 0
`;
}

function panelResolution(over: Partial<PanelResolution>): PanelResolution {
  return {
    settings: null,
    confidence: 'none',
    path: null,
    candidates: 0,
    ...over,
  };
}

const WIRED_PANEL = panelResolution({
  settings: {
    name: 'MainPanel',
    scaleMode: 'constant-pixel',
    scale: 1,
    referenceResolution: { width: 1200, height: 800 },
    screenMatchMode: 'match-width-or-height',
    match: 0,
    referenceDpi: 96,
    fallbackDpi: 96,
  },
  confidence: 'wired',
  path: 'Assets/UI/MainPanel.asset',
  candidates: 1,
});

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

/**
 * Deliberately lint-clean: away from every panel edge and carrying no "hud"
 * name/class, so the default fixture never trips a finding by accident — a
 * test that wants one builds its own node.
 */
function probeOutput(over: Partial<ProbeLayoutOutput> = {}): ProbeLayoutOutput {
  return {
    nodes: [node({ name: 'screen-root', box: { x: 100, y: 100, w: 800, h: 600 } })],
    truncated: false,
    notes: [],
    ...over,
  };
}

function baseDeps(over: Partial<UiLayoutToolDeps> = {}): UiLayoutToolDeps {
  return {
    readFile: async (abs) => (abs === ABS ? HUD : null),
    guidMap: async () => ({}),
    loadStyleSheets: async (): Promise<LoadedStyles> => ({ sheets: [], unresolved: [] }),
    loadPanelSettings: async () => WIRED_PANEL,
    probe: async () => probeOutput(),
    ...over,
  };
}

async function run(params: object, over: Partial<UiLayoutToolDeps> = {}): Promise<string> {
  const tool = createUnityUiLayoutTool(WS, baseDeps(over));
  const result = await tool.execute('id', params);
  return result.content[0]?.type === 'text' ? result.content[0].text : '';
}

afterEach(() => {
  resetPendingGuidChecks();
});

describe('unity_ui_layout — input guards', () => {
  it('refuses a non-.uxml document', async () => {
    const out = await run({ document: 'Assets/UI/Theme.uss' });
    expect(out).toContain('only lays out .uxml documents');
  });

  it('says so when the document cannot be read', async () => {
    const out = await run({ document: 'Assets/UI/Missing.uxml' });
    expect(out).toContain('Could not read');
    expect(out).toContain('unity_ui_toolkit');
  });

  it('says so when the document has no root element', async () => {
    const out = await run({ document: DOC }, { readFile: async () => '' });
    expect(out).toContain('no root element to lay out');
  });

  it('reports a probe failure rather than throwing', async () => {
    const out = await run(
      { document: DOC },
      { probe: async () => { throw new Error('offscreen host explosion'); } },
    );
    expect(out).toContain('Could not lay out');
    expect(out).toContain('offscreen host explosion');
  });
});

describe('unity_ui_layout — panel confidence header', () => {
  it('states "wired" when the document is wired to a PanelSettings', async () => {
    const out = await run({ document: DOC }, { loadPanelSettings: async () => WIRED_PANEL });
    expect(out).toContain('Panel: MainPanel — wired');
    expect(out).toContain('laid out at 1920 × 1080');
  });

  it('states "only panel" when the project has exactly one candidate', async () => {
    const only = panelResolution({
      settings: WIRED_PANEL.settings,
      confidence: 'only',
      path: 'Assets/UI/MainPanel.asset',
      candidates: 1,
    });
    const out = await run({ document: DOC }, { loadPanelSettings: async () => only });
    expect(out).toContain('only panel in the project');
  });

  it('states "assumed" with the candidate count when several panels exist and none is wired', async () => {
    const ambiguous = panelResolution({
      settings: { ...WIRED_PANEL.settings!, name: 'SecondaryPanel' },
      confidence: 'ambiguous',
      path: 'Assets/UI/SecondaryPanel.asset',
      candidates: 3,
    });
    const out = await run({ document: DOC }, { loadPanelSettings: async () => ambiguous });
    expect(out).toContain('SecondaryPanel — assumed (3 panels, none wired to this document)');
  });

  it('states "no PanelSettings — screen size" and falls back to 1920×1080 when none exist', async () => {
    const out = await run({ document: DOC }, { loadPanelSettings: async () => panelResolution({}) });
    expect(out).toContain('no PanelSettings — screen size');
    expect(out).toContain('laid out at 1920 × 1080');
  });

  it('falls back to assumed and says so when loadPanelSettings throws', async () => {
    const out = await run(
      { document: DOC },
      {
        loadPanelSettings: async () => {
          throw new Error('scan_all_files_v2 failed');
        },
      },
    );
    expect(out).toContain('no PanelSettings — screen size');
    expect(out).toContain('Could not resolve PanelSettings for this document — assuming 1920×1080.');
  });

  it('uses an explicit panel param over the wired/only/ambiguous ladder', async () => {
    const out = await run(
      { document: DOC, panel: 'Assets/UI/Explicit.asset' },
      {
        readFile: async (abs) => {
          if (abs === ABS) return HUD;
          if (abs === `${WS}/Assets/UI/Explicit.asset`) return panelAsset('ExplicitPanel', 960, 540);
          return null;
        },
      },
    );
    expect(out).toContain('ExplicitPanel');
    expect(out).toContain('explicit');
  });

  it('falls back to the ladder and says so when the explicit panel param is not a readable PanelSettings', async () => {
    const out = await run(
      { document: DOC, panel: 'Assets/UI/NotAPanel.asset' },
      { loadPanelSettings: async () => WIRED_PANEL },
    );
    expect(out).toContain('Could not use the requested panel "Assets/UI/NotAPanel.asset"');
    expect(out).toContain('Falling back: MainPanel — wired');
  });
});

describe('unity_ui_layout — tree and problems', () => {
  it('renders the probed tree', async () => {
    const out = await run(
      { document: DOC },
      { probe: async () => probeOutput({ nodes: [node({ name: 'hud-root', box: { x: 0, y: 0, w: 800, h: 600 } })] }) },
    );
    expect(out).toContain('hud-root VisualElement [0,0 800×600]');
  });

  it('reports "Problems: none" when the lint pass finds nothing', async () => {
    const out = await run({ document: DOC });
    expect(out).toContain('Problems: none');
  });

  it('reports "Problems (n):" with the lint findings when the layout has bugs', async () => {
    const out = await run(
      { document: DOC },
      {
        probe: async () =>
          probeOutput({
            nodes: [
              node({
                name: 'pause-button',
                kind: 'Button',
                box: { x: 10, y: 10, w: 40, h: 18 },
              }),
            ],
          }),
      },
    );
    expect(out).toContain('Problems (1):');
    expect(out).toContain('button-too-small');
    expect(out).toContain('pause-button');
  });

  it('passes maxDepth and includeStyles through to the tree renderer', async () => {
    const out = await run(
      { document: DOC, includeStyles: true },
      {
        probe: async () =>
          probeOutput({ nodes: [node({ name: 'root', styles: { display: 'flex', flexDirection: 'row' } })] }),
      },
    );
    expect(out).toContain('{display:flex; flex-direction:row}');
  });
});

describe('unity_ui_layout — notes', () => {
  it('surfaces the render plan\'s own notes', async () => {
    const out = await run(
      { document: DOC },
      { probe: async () => probeOutput({ notes: ["Unity's built-in theme is not on disk"] }) },
    );
    expect(out).toContain('Notes:');
    expect(out).toContain("Unity's built-in theme is not on disk");
  });

  it('surfaces unresolved stylesheets from loadStyleSheets', async () => {
    const out = await run(
      { document: DOC },
      { loadStyleSheets: async () => ({ sheets: [], unresolved: ['Theme.uss could not be read.'] }) },
    );
    expect(out).toContain('Theme.uss could not be read.');
  });

  it('adds a truncation note naming the maxNodes that was used, when the probe stopped early', async () => {
    const out = await run(
      { document: DOC, maxNodes: 50 },
      { probe: async () => probeOutput({ truncated: true }) },
    );
    expect(out).toContain('Layout probe stopped at 50 nodes');
  });

  it('names the default maxNodes in the truncation note when none was requested', async () => {
    const out = await run({ document: DOC }, { probe: async () => probeOutput({ truncated: true }) });
    expect(out).toContain('Layout probe stopped at 400 nodes');
  });
});

describe('unity_ui_layout — image param', () => {
  it('returns the fixed "not available" sentence rather than rasterizing', async () => {
    const out = await run({ document: DOC, image: true });
    expect(out).toContain(
      'An image preview is not available for the current model; the layout tree above is the authoritative view.',
    );
  });

  it('omits the image note when image is not requested', async () => {
    const out = await run({ document: DOC });
    expect(out).not.toContain('image preview');
  });
});

describe('unity_ui_layout — pending GUID checks (Task 14 loop-close)', () => {
  it('says nothing about GUIDs when nothing is pending', async () => {
    const out = await run({ document: DOC });
    expect(out).not.toContain('GUID check');
  });

  it('confirms a write when the .meta on disk matches the allocated guid', async () => {
    const guid = 'a'.repeat(32);
    registerPendingGuidCheck('Assets/UI/HUD.uxml', guid);
    const out = await run(
      { document: DOC },
      {
        readFile: async (abs) => {
          if (abs === ABS) return HUD;
          if (abs === `${ABS}.meta`) return `fileFormatVersion: 2\nguid: ${guid}\n`;
          return null;
        },
      },
    );
    expect(out).toContain('GUID check:');
    expect(out).toContain('1 write confirmed — Unity kept the GUID this session assigned.');
  });

  it('reports a reassigned GUID by name, with both values, when Unity resolved a collision', async () => {
    const allocated = 'a'.repeat(32);
    const reassigned = 'b'.repeat(32);
    registerPendingGuidCheck('Assets/UI/HUD.uxml', allocated);
    const out = await run(
      { document: DOC },
      {
        readFile: async (abs) => {
          if (abs === ABS) return HUD;
          if (abs === `${ABS}.meta`) return `fileFormatVersion: 2\nguid: ${reassigned}\n`;
          return null;
        },
      },
    );
    expect(out).toContain(
      `Unity reassigned the GUID for Assets/UI/HUD.uxml (expected ${allocated}, now ${reassigned}) — references written this turn must be updated.`,
    );
  });

  it('says Unity has not imported the file yet when no .meta exists on disk', async () => {
    registerPendingGuidCheck('Assets/UI/HUD.uxml', 'a'.repeat(32));
    const out = await run(
      { document: DOC },
      {
        readFile: async (abs) => (abs === ABS ? HUD : null),
      },
    );
    expect(out).toContain('Unity has not imported it yet');
  });

  it('drains the registry — a second call in the same send reports nothing pending', async () => {
    registerPendingGuidCheck('Assets/UI/HUD.uxml', 'a'.repeat(32));
    await run(
      { document: DOC },
      {
        readFile: async (abs) => {
          if (abs === ABS) return HUD;
          if (abs === `${ABS}.meta`) return `fileFormatVersion: 2\nguid: ${'a'.repeat(32)}\n`;
          return null;
        },
      },
    );
    const second = await run({ document: DOC });
    expect(second).not.toContain('GUID check');
  });
});
