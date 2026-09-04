// `unity_ui_scaffold` reaches `unity-facts.ts` (Bun-unsafe — statically
// imports `stores/workspace.ts`) only through its DEFAULT deps' dynamic
// imports, so the tool itself is tested here with fakes for `stack`/`design`,
// the same DI-seam pattern `ui-write-tool.test.ts` uses for its own `stack`.

import { describe, it, expect } from 'bun:test';
import { createUnityUiScaffoldTool, type UiScaffoldToolDeps } from './ui-scaffold-tool';
import { DESIGN_RULES, type UiDesignFacts } from '../prompts/ui-design-facts';

const WS = '/proj';

function harness(overrides: Partial<UiScaffoldToolDeps> = {}) {
  const deps: UiScaffoldToolDeps = {
    async stack() {
      return 'none';
    },
    async design() {
      return null;
    },
    ...overrides,
  };
  return { deps };
}

async function run(params: object, deps: UiScaffoldToolDeps, workspacePath = WS): Promise<string> {
  const result = await createUnityUiScaffoldTool(workspacePath, deps).execute('id', params);
  return result.content[0]?.type === 'text' ? result.content[0].text : '';
}

function designWith(over: Partial<UiDesignFacts>): UiDesignFacts {
  return { variables: [], panels: [], themeSheets: [], stack: 'uitoolkit', ...over };
}

describe('unity_ui_scaffold — uGUI refusal', () => {
  it('refuses in a uGUI project with the Task 14 copy, ending on the scaffold-specific line', async () => {
    const { deps } = harness({ stack: async () => 'ugui' });
    const out = await run({ screen: 'hud', name: 'HUD' }, deps);
    expect(out).toContain('This project uses uGUI (Canvas) and has no UI Toolkit documents.');
    expect(out).toContain('Ask the user first, then pass adoptUiToolkit:true to unity_ui_write.');
    expect(out).not.toContain('unity_ui_write path=');
  });

  it.each(['uitoolkit', 'both', 'none'] as const)('never refuses for stack=%s', async (stack) => {
    const { deps } = harness({ stack: async () => stack });
    const out = await run({ screen: 'hud', name: 'HUD' }, deps);
    expect(out).not.toContain('uGUI (Canvas)');
  });

  it('does not refuse when the stack is undetermined (null)', async () => {
    const { deps } = harness({ stack: async () => null });
    const out = await run({ screen: 'hud', name: 'HUD' }, deps);
    expect(out).not.toContain('uGUI (Canvas)');
  });

  it('does not refuse when stack() throws — degrades to proceeding, not crashing', async () => {
    const { deps } = harness({
      stack: async () => {
        throw new Error('unity-facts unavailable');
      },
    });
    const out = await run({ screen: 'hud', name: 'HUD' }, deps);
    expect(out).not.toContain('uGUI (Canvas)');
    expect(out).toContain('unity_ui_write path="Assets/UI/HUD.uxml"');
  });
});

describe('unity_ui_scaffold — recipe ordering (USS before UXML)', () => {
  it('orders theme, then component USS, then UXML when no theme exists to reuse', async () => {
    const { deps } = harness();
    const out = await run({ screen: 'hud', name: 'HUD' }, deps);
    const themeAt = out.indexOf('unity_ui_write path="Assets/UI/HUDTheme.uss"');
    const ussAt = out.indexOf('unity_ui_write path="Assets/UI/HUD.uss"');
    const uxmlAt = out.indexOf('unity_ui_write path="Assets/UI/HUD.uxml"');
    expect(themeAt).toBeGreaterThan(-1);
    expect(ussAt).toBeGreaterThan(-1);
    expect(uxmlAt).toBeGreaterThan(-1);
    expect(themeAt).toBeLessThan(ussAt);
    expect(ussAt).toBeLessThan(uxmlAt);
  });

  it('orders component USS before UXML when reusing an existing theme (no theme write at all)', async () => {
    const { deps } = harness({
      design: async () => designWith({ themeSheets: ['Theme.uss'] }),
    });
    const out = await run({ screen: 'hud', name: 'HUD' }, deps);
    expect(out).not.toContain('HUDTheme.uss');
    const ussAt = out.indexOf('unity_ui_write path="Assets/UI/HUD.uss"');
    const uxmlAt = out.indexOf('unity_ui_write path="Assets/UI/HUD.uxml"');
    expect(ussAt).toBeGreaterThan(-1);
    expect(uxmlAt).toBeGreaterThan(-1);
    expect(ussAt).toBeLessThan(uxmlAt);
  });
});

describe('unity_ui_scaffold — theme reuse', () => {
  it('reuses the existing theme by default when one exists, and resolves {{THEME_SRC}} to its path', async () => {
    const { deps } = harness({
      design: async () => designWith({ themeSheets: ['Theme.uss'] }),
    });
    const out = await run({ screen: 'hud', name: 'HUD' }, deps);
    expect(out).toContain('Reusing this project\'s existing theme, assumed at Assets/UI/Theme.uss');
    expect(out).not.toContain('{{THEME_SRC}}');
    expect(out).toContain('src="Assets/UI/Theme.uss"');
  });

  it('emits a fresh theme when reuseTheme:false is passed explicitly, even though one exists', async () => {
    const { deps } = harness({
      design: async () => designWith({ themeSheets: ['Theme.uss'] }),
    });
    const out = await run({ screen: 'hud', name: 'HUD', reuseTheme: false }, deps);
    expect(out).toContain('unity_ui_write path="Assets/UI/HUDTheme.uss"');
    expect(out).toContain('{{THEME_SRC}}');
  });

  it('emits a fresh theme when none exists, regardless of reuseTheme defaulting true', async () => {
    const { deps } = harness();
    const out = await run({ screen: 'hud', name: 'HUD' }, deps);
    expect(out).toContain('unity_ui_write path="Assets/UI/HUDTheme.uss"');
  });
});

describe('unity_ui_scaffold — directory', () => {
  it('defaults to Assets/UI', async () => {
    const { deps } = harness();
    const out = await run({ screen: 'dialog', name: 'ConfirmQuit' }, deps);
    expect(out).toContain('unity_ui_write path="Assets/UI/ConfirmQuit.uxml"');
  });

  it('honors a custom directory, trimming a trailing slash', async () => {
    const { deps } = harness();
    const out = await run({ screen: 'dialog', name: 'ConfirmQuit', directory: 'Assets/Screens/' }, deps);
    expect(out).toContain('unity_ui_write path="Assets/Screens/ConfirmQuit.uxml"');
    expect(out).toContain('unity_ui_write path="Assets/Screens/ConfirmQuit.uss"');
  });
});

describe('unity_ui_scaffold — recipe sections', () => {
  it('lists the element names the controller must use', async () => {
    const { deps } = harness();
    const out = await run({ screen: 'hud', name: 'HUD' }, deps);
    expect(out).toContain('Element names the controller must use:');
    expect(out).toContain('hud-hp-value');
    expect(out).toContain('hud-pause-button');
  });

  it('includes a minimal controller skeleton with Q<Label>("hud-hp-value")-style bindings', async () => {
    const { deps } = harness();
    const out = await run({ screen: 'hud', name: 'HUD' }, deps);
    expect(out).toContain('Q<Label>("hud-hp-value")');
    expect(out).toContain('public class HUDController : MonoBehaviour');
    expect(out).toContain('Assets/Scripts/UI/HUDController.cs');
  });

  it('reuses the exported DESIGN_RULES verbatim, not a paraphrase', async () => {
    const { deps } = harness();
    const out = await run({ screen: 'hud', name: 'HUD' }, deps);
    for (const rule of DESIGN_RULES) expect(out).toContain(rule);
  });

  it('ends with the wiring step: unity_attach_ui_document and a unity_ui_layout reminder', async () => {
    const { deps } = harness();
    const out = await run({ screen: 'hud', name: 'HUD' }, deps);
    expect(out).toContain('unity_attach_ui_document with document: "Assets/UI/HUD.uxml"');
    expect(out).toContain('unity_ui_layout');
  });

  it('states the reference resolution, defaulting to 1920×1080 with no PanelSettings', async () => {
    const { deps } = harness();
    const out = await run({ screen: 'hud', name: 'HUD' }, deps);
    expect(out).toContain('Reference resolution: 1920×1080 (default');
  });

  it('states a project PanelSettings\' actual reference resolution when one is found', async () => {
    const { deps } = harness({
      design: async () =>
        designWith({
          panels: [
            {
              name: 'MainPanel',
              path: 'Assets/UI/MainPanel.asset',
              scaleMode: 'scale-with-screen',
              referenceResolution: { w: 1280, h: 720 },
              screenMatchMode: 'match-width-or-height',
              match: 0.5,
            },
          ],
        }),
    });
    const out = await run({ screen: 'hud', name: 'HUD' }, deps);
    expect(out).toContain('Reference resolution: 1280×720 (from MainPanel).');
  });
});

describe('unity_ui_scaffold — every screen produces a recipe', () => {
  it.each(['hud', 'main-menu', 'settings', 'dialog', 'inventory'] as const)(
    'builds a full recipe for screen=%s with no crash',
    async (screen) => {
      const { deps } = harness();
      const out = await run({ screen, name: 'Test' }, deps);
      expect(out).toContain('unity_ui_write path="Assets/UI/Test.uss"');
      expect(out).toContain('unity_ui_write path="Assets/UI/Test.uxml"');
      expect(out).toContain('public class TestController : MonoBehaviour');
    },
  );
});

describe('unity_ui_scaffold — degraded design lookup', () => {
  it('does not crash when design() throws, and still produces a full recipe with theme defaults', async () => {
    const { deps } = harness({
      design: async () => {
        throw new Error('unity-facts unavailable');
      },
    });
    const out = await run({ screen: 'hud', name: 'HUD' }, deps);
    expect(out).toContain('unity_ui_write path="Assets/UI/HUDTheme.uss"');
    expect(out).toContain('--color-bg');
  });
});
