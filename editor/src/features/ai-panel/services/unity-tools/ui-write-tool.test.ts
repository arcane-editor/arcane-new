// `ui-write-tool.ts` reaches `asset-gate.ts`/`unity-facts.ts` (both Bun-unsafe —
// see their own headers) only through its DEFAULT deps' dynamic imports, so the
// tool itself is tested directly here with fakes for every dependency, the same
// DI-seam pattern `input-edit-tool.test.ts` uses.

import { describe, it, expect, afterEach } from 'bun:test';
import { createUnityUiWriteTool, type UiWriteToolDeps } from './ui-write-tool';
import type { UxmlCheckContext } from './asset-checks';
// `unity_ui_write` registers every successful write with guid-verify.ts's
// module-level (not injected) registry — real production wiring, same as
// `mutate-tools.ts` calling `test-run-registry.ts` directly. Bun runs every
// test file in one process, so a run that leaves entries behind here would
// leak into `guid-verify.test.ts`'s "starts empty" — clean up after every test.
import { resetPendingGuidChecks, takePendingGuidChecks } from './guid-verify';

afterEach(() => {
  resetPendingGuidChecks();
});

const WS = '/ws';

const SIMPLE_UXML =
  '<ui:UXML xmlns:ui="UnityEngine.UIElements"><ui:VisualElement name="root" /></ui:UXML>';
const BROKEN_UXML = '<ui:UXML xmlns:ui="UnityEngine.UIElements"><ui:VisualElement name="root">';
const UXML_WITH_MISSING_STYLE =
  '<ui:UXML xmlns:ui="UnityEngine.UIElements">' +
  '<Style src="project://database/Assets/UI/HUD.uss?fileID=7433441132597879392&amp;guid=' +
  'd'.repeat(32) +
  '&amp;type=3#HUD" />' +
  '<ui:VisualElement name="root" /></ui:UXML>';
const UXML_WITH_UNDECLARED_CLASS =
  '<ui:UXML xmlns:ui="UnityEngine.UIElements"><ui:VisualElement name="root" class="ghost" /></ui:UXML>';

const SIMPLE_USS = '.hud { color: red; }';
const USS_WITH_CSS_ONLY_PROP = '.hud { box-shadow: 1px 1px 1px black; }';
const USS_WITH_UNKNOWN_PROP = '.hud { -unity-future-thing: 4px; }';

const NEUTRAL_CTX: UxmlCheckContext = {
  declaredClasses: new Set(),
  csReferencedClasses: new Set(),
  ussPaths: [],
};

function harness(overrides: Partial<UiWriteToolDeps> = {}) {
  const files = new Map<string, string>();
  const existsSet = new Set<string>();
  const written: Array<{ path: string; content: string }> = [];
  const notified: string[] = [];
  const preWrites: Array<{ path: string; before: string | null }> = [];

  const deps: UiWriteToolDeps = {
    async write(absPath, content) {
      written.push({ path: absPath, content });
      files.set(absPath, content);
      existsSet.add(absPath);
    },
    async exists(absPath) {
      return existsSet.has(absPath);
    },
    async readFile(absPath) {
      return files.get(absPath) ?? null;
    },
    async guidMap() {
      return {};
    },
    async snapshot() {
      return NEUTRAL_CTX;
    },
    async stack() {
      return 'none';
    },
    onWrite: (p) => notified.push(p),
    recordPreWrite: (p, before) => preWrites.push({ path: p, before }),
    ...overrides,
  };

  return { deps, files, existsSet, written, notified, preWrites };
}

async function run(params: object, deps: UiWriteToolDeps, workspacePath = WS): Promise<string> {
  const result = await createUnityUiWriteTool(workspacePath, deps).execute('id', params);
  return result.content[0]?.type === 'text' ? result.content[0].text : '';
}

describe('unity_ui_write — extension guard', () => {
  it('refuses anything that is not .uxml/.uss', async () => {
    const { deps, written } = harness();
    const out = await run({ path: 'Assets/UI/HUD.png', content: 'x' }, deps);
    expect(out).toContain('only writes .uxml and .uss files');
    expect(out).toContain('use write / unity_asset_edit');
    expect(written).toHaveLength(0);
  });
});

describe('unity_ui_write — uGUI refusal', () => {
  it('refuses UXML in a uGUI project without adoptUiToolkit', async () => {
    const { deps, written } = harness({ stack: async () => 'ugui' });
    const out = await run({ path: 'Assets/UI/HUD.uxml', content: SIMPLE_UXML }, deps);
    expect(out).toContain('This project uses uGUI (Canvas) and has no UI Toolkit documents.');
    expect(out).toContain('adoptUiToolkit:true');
    expect(written).toHaveLength(0);
  });

  it('writes once adoptUiToolkit is set', async () => {
    const { deps, written } = harness({ stack: async () => 'ugui' });
    const out = await run(
      { path: 'Assets/UI/HUD.uxml', content: SIMPLE_UXML, adoptUiToolkit: true },
      deps,
    );
    expect(out).not.toContain('uGUI (Canvas)');
    expect(written.map((w) => w.path)).toContain(`${WS}/Assets/UI/HUD.uxml`);
  });

  it.each(['uitoolkit', 'both', 'none'] as const)('never refuses for stack=%s', async (stack) => {
    const { deps, written } = harness({ stack: async () => stack });
    const out = await run({ path: 'Assets/UI/HUD.uxml', content: SIMPLE_UXML }, deps);
    expect(out).not.toContain('uGUI (Canvas)');
    expect(written.length).toBeGreaterThan(0);
  });
});

describe('unity_ui_write — UXML validation', () => {
  it('refuses a write that does not parse', async () => {
    const { deps, written } = harness();
    const out = await run({ path: 'Assets/UI/HUD.uxml', content: BROKEN_UXML }, deps);
    expect(out).toContain('does not parse');
    expect(written).toHaveLength(0);
  });

  it('refuses a <Style src> pointing at a .uss that is not on disk', async () => {
    const { deps, written } = harness();
    const out = await run({ path: 'Assets/UI/HUD.uxml', content: UXML_WITH_MISSING_STYLE }, deps);
    expect(out).toContain('references a stylesheet that does not exist');
    expect(written).toHaveLength(0);
  });

  it('allows the same write once the referenced .uss actually exists on disk', async () => {
    const { deps, written, existsSet } = harness();
    existsSet.add(`${WS}/Assets/UI/HUD.uss`);
    const out = await run({ path: 'Assets/UI/HUD.uxml', content: UXML_WITH_MISSING_STYLE }, deps);
    expect(out).not.toContain('does not exist');
    expect(written.map((w) => w.path)).toContain(`${WS}/Assets/UI/HUD.uxml`);
  });

  it('writes but warns on an undeclared class instead of refusing', async () => {
    const { deps, written } = harness();
    const out = await run({ path: 'Assets/UI/HUD.uxml', content: UXML_WITH_UNDECLARED_CLASS }, deps);
    expect(written.map((w) => w.path)).toContain(`${WS}/Assets/UI/HUD.uxml`);
    expect(out).toContain('[Unity UXML]');
    expect(out).toContain('ghost');
  });

  it('reports the declared element names', async () => {
    const { deps } = harness();
    const out = await run({ path: 'Assets/UI/HUD.uxml', content: SIMPLE_UXML }, deps);
    expect(out).toContain('Declared element names: root.');
  });

  it('says the document styles nothing when it references no stylesheet', async () => {
    // The commonest way a generated screen comes out unstyled, and this line is
    // the last moment anything says so before the model moves on to wiring.
    const { deps } = harness();
    const out = await run({ path: 'Assets/UI/HUD.uxml', content: SIMPLE_UXML }, deps);
    expect(out).toContain('references no stylesheet');
    expect(out).toContain('unity_ui_write the .uss');
  });

  it('counts the classes that style nothing, so the cost is concrete', async () => {
    const { deps } = harness();
    const styled =
      '<ui:UXML xmlns:ui="UnityEngine.UIElements">' +
      '<ui:VisualElement name="root" class="menu"><ui:Button class="btn btn--primary" /></ui:VisualElement>' +
      '</ui:UXML>';
    const out = await run({ path: 'Assets/UI/HUD.uxml', content: styled }, deps);
    expect(out).toContain('3 classes style nothing');
  });

  it('names the layout and wiring tools once a stylesheet IS referenced', async () => {
    const { deps, existsSet } = harness();
    existsSet.add(`${WS}/Assets/UI/HUD.uss`);
    const withSheet =
      '<ui:UXML xmlns:ui="UnityEngine.UIElements">' +
      '<Style src="HUD.uss" />' +
      '<ui:VisualElement name="root" class="menu" />' +
      '</ui:UXML>';
    const out = await run({ path: 'Assets/UI/HUD.uxml', content: withSheet }, deps);
    expect(out).toContain('Next: unity_ui_layout');
    expect(out).toContain('unity_attach_ui_document');
  });
});

describe('unity_ui_write — USS validation', () => {
  it('refuses a property USS does not implement — it would import clean and apply nothing', async () => {
    const { deps, written } = harness();
    const out = await run({ path: 'Assets/UI/HUD.uss', content: USS_WITH_CSS_ONLY_PROP }, deps);
    expect(written).toHaveLength(0);
    expect(out).toContain('box-shadow');
    expect(out).toContain('9-slice');
  });

  it('writes a merely-unknown property and appends the finding rather than refusing', async () => {
    // The registry can be behind Unity; refusing here would strand the agent on
    // a stylesheet it has no way to correct.
    const { deps, written } = harness();
    const out = await run({ path: 'Assets/UI/HUD.uss', content: USS_WITH_UNKNOWN_PROP }, deps);
    expect(written.map((w) => w.path)).toContain(`${WS}/Assets/UI/HUD.uss`);
    expect(out).toContain('[Unity USS]');
    expect(out).toContain('-unity-future-thing');
  });

  it('emits a project:// <Style src> using the guid it allocated', async () => {
    const { deps } = harness();
    const out = await run({ path: 'Assets/UI/HUD.uss', content: SIMPLE_USS }, deps);
    expect(out).toMatch(
      /<Style src="project:\/\/database\/Assets\/UI\/HUD\.uss\?fileID=7433441132597879392&amp;guid=[0-9a-f]{32}&amp;type=3#HUD" \/>/,
    );
  });
});

describe('unity_ui_write — .meta creation', () => {
  it('creates a .meta when none exists, notifies onWrite for both, and records a null pre-image', async () => {
    const { deps, written, notified, preWrites } = harness();
    const out = await run({ path: 'Assets/UI/HUD.uss', content: SIMPLE_USS }, deps);

    const metaAbs = `${WS}/Assets/UI/HUD.uss.meta`;
    expect(written.find((w) => w.path === metaAbs)).toBeDefined();
    expect(notified).toEqual(['Assets/UI/HUD.uss', 'Assets/UI/HUD.uss.meta']);
    expect(preWrites).toEqual([{ path: metaAbs, before: null }]);
    expect(out).toContain('and HUD.uss.meta.');
  });

  it('does not recreate a .meta that already exists, and registers no pending guid check when the ASSET already existed too', async () => {
    const { deps, written, notified, existsSet, files } = harness();
    const assetAbs = `${WS}/Assets/UI/HUD.uss`;
    const metaAbs = `${assetAbs}.meta`;
    const existingGuid = 'c'.repeat(32);
    files.set(metaAbs, `fileFormatVersion: 2\nguid: ${existingGuid}\n`);
    existsSet.add(metaAbs);
    existsSet.add(assetAbs); // rewriting content on an asset Unity already imported

    const out = await run({ path: 'Assets/UI/HUD.uss', content: SIMPLE_USS }, deps);

    expect(written.find((w) => w.path === metaAbs)).toBeUndefined();
    expect(notified).toEqual(['Assets/UI/HUD.uss']);
    expect(out).toContain(`(guid ${existingGuid})`);
    expect(out).not.toContain('and HUD.uss.meta.');
    // Both the asset and its .meta pre-existed — this guid is already
    // Unity-confirmed, nothing pending.
    expect(takePendingGuidChecks()).toEqual([]);
  });

  it('registers a pending guid check for an orphan .meta whose asset did not exist yet — a first import from Unity\'s point of view (M1)', async () => {
    const { deps, existsSet, files } = harness();
    const metaAbs = `${WS}/Assets/UI/HUD.uss.meta`;
    const orphanGuid = 'e'.repeat(32);
    files.set(metaAbs, `fileFormatVersion: 2\nguid: ${orphanGuid}\n`);
    existsSet.add(metaAbs);
    // The asset path itself is deliberately NOT pre-seeded — it does not
    // exist until this write.

    const out = await run({ path: 'Assets/UI/HUD.uss', content: SIMPLE_USS }, deps);

    expect(out).toContain(`(guid ${orphanGuid})`);
    expect(takePendingGuidChecks()).toEqual([{ path: 'Assets/UI/HUD.uss', guid: orphanGuid }]);
  });

  it('registers a freshly allocated guid as pending, for Task 15 to verify once Unity imports it', async () => {
    const { deps } = harness();
    await run({ path: 'Assets/UI/HUD.uss', content: SIMPLE_USS }, deps);
    const pending = takePendingGuidChecks();
    expect(pending).toHaveLength(1);
    expect(pending[0].path).toBe('Assets/UI/HUD.uss');
    expect(pending[0].guid).toMatch(/^[0-9a-f]{32}$/);
  });

  it('copies an existing same-kind .meta as the template for a new one', async () => {
    const { deps, written } = harness();
    const existingUxmlAbs = `${WS}/Assets/UI/Other.uxml`;
    const templateGuid = 'c'.repeat(32);
    deps.guidMap = async () => ({ [templateGuid]: existingUxmlAbs });
    deps.readFile = async (absPath) =>
      absPath === `${existingUxmlAbs}.meta`
        ? [
            'fileFormatVersion: 2',
            `guid: ${templateGuid}`,
            'ScriptedImporter:',
            '  nameOverride: SomeCustomSetting',
            '',
          ].join('\n')
        : null;

    await run({ path: 'Assets/UI/HUD.uxml', content: SIMPLE_UXML }, deps);

    const meta = written.find((w) => w.path === `${WS}/Assets/UI/HUD.uxml.meta`);
    expect(meta?.content).toContain('nameOverride: SomeCustomSetting');
    expect(meta?.content).not.toContain(`guid: ${templateGuid}`);
  });

  it('falls back to a relative <Style src> when an existing .meta cannot be read', async () => {
    const { deps, existsSet } = harness();
    existsSet.add(`${WS}/Assets/UI/HUD.uss.meta`); // exists, but readFile (unmodified) returns null
    const out = await run({ path: 'Assets/UI/HUD.uss', content: SIMPLE_USS }, deps);
    expect(out).toContain('GUID is unknown');
    expect(out).toContain('<Style src="Assets/UI/HUD.uss" />');
  });
});

describe('unity_ui_write — degraded guid-index lookup (F2)', () => {
  it('still writes, still allocates and registers a guid, and notes the degraded collision check', async () => {
    const { deps, written } = harness({
      guidMap: async () => {
        throw new Error('unity_index_guid_map unavailable');
      },
    });

    const out = await run({ path: 'Assets/UI/HUD.uss', content: SIMPLE_USS }, deps);

    const metaAbs = `${WS}/Assets/UI/HUD.uss.meta`;
    expect(written.find((w) => w.path === metaAbs)).toBeDefined();
    expect(out).toContain(
      'Note: the project GUID index was unavailable, so this GUID was checked only against files written this send.',
    );
    // Still registered — this IS the check that would catch a collision the
    // degraded lookup here could not.
    expect(takePendingGuidChecks()).toHaveLength(1);
  });

  it('does not append the degraded-index note when the guid map lookup succeeds', async () => {
    const { deps } = harness();
    const out = await run({ path: 'Assets/UI/HUD.uss', content: SIMPLE_USS }, deps);
    expect(out).not.toContain('GUID index was unavailable');
  });
});

describe('unity_ui_write — undetermined UI stack (M2)', () => {
  it('proceeds (never refuses) and notes that the stack could not be determined, when stack() resolves null', async () => {
    const { deps, written } = harness({ stack: async () => null });
    const out = await run({ path: 'Assets/UI/HUD.uxml', content: SIMPLE_UXML }, deps);
    expect(out).not.toContain('uGUI (Canvas)');
    expect(written.map((w) => w.path)).toContain(`${WS}/Assets/UI/HUD.uxml`);
    expect(out).toContain("Note: the project's UI stack could not be determined before writing.");
  });

  it('proceeds and notes it the same way when stack() itself throws', async () => {
    const { deps } = harness({
      stack: async () => {
        throw new Error('unity-facts unavailable');
      },
    });
    const out = await run({ path: 'Assets/UI/HUD.uxml', content: SIMPLE_UXML }, deps);
    expect(out).toContain("Note: the project's UI stack could not be determined before writing.");
  });

  it('does not append the undetermined-stack note once the stack is actually known', async () => {
    const { deps } = harness({ stack: async () => 'none' });
    const out = await run({ path: 'Assets/UI/HUD.uxml', content: SIMPLE_UXML }, deps);
    expect(out).not.toContain('UI stack could not be determined');
  });
});
