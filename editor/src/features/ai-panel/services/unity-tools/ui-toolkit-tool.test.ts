// The `Q<T>("name")` boundary is a heuristic over data the compiler cannot see,
// so the rule inherited from `resolveQueryName` is that a false "missing" costs
// more than a missed warning. These tests pin that direction: every suppression
// rung has a case, and the only verdict that accuses the user is the one that
// clears all of them.

import { describe, it, expect } from 'bun:test';
import {
  createUnityUiToolkitTool,
  invalidUssProperties,
  undeclaredClasses,
  renderInventory,
  type UiToolkitToolDeps,
  type UiToolkitSnapshot,
} from './ui-toolkit-tool';
import type { CsUiRefIndex, UxmlIndex, UssIndex } from '../../../unity-analyzers';
import type { ElementUsage } from '../../../../utils/uxml-usage';
import { parseUxml, offsetToPosition, type UxmlNode } from '../../../../utils/uxml-model';
import { parseUss } from '../../../../utils/uss-model';

// The indexes are built here rather than imported from `uitoolkit-cache.ts`:
// that module sits behind the `unity-analyzers` barrel, which pulls Monaco and
// cannot be imported under Bun, and reaching past the barrel is a module-boundary
// violation `check:modules` rejects. Both builders are small and their shapes
// are part of the type the tool consumes, so mirroring them here also keeps the
// test honest about what the tool actually reads.
function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) {
    if (!list.includes(value)) list.push(value);
  } else map.set(key, [value]);
}

function buildUxmlIndex(assets: Array<{ path: string; content: string }>): UxmlIndex {
  const docs = new Map<string, ReturnType<typeof parseUxml>>();
  const namesToDocs = new Map<string, string[]>();
  const classesToDocs = new Map<string, string[]>();
  const elements = new Map<string, UxmlIndex['elements'] extends Map<string, infer V> ? V : never>();
  for (const asset of assets) {
    const doc = parseUxml(asset.content);
    docs.set(asset.path, doc);
    const walk = (node: UxmlNode | null): void => {
      if (!node) return;
      if (node.name) {
        push(namesToDocs, node.name, asset.path);
        const attr = node.attrs.find((a) => a.name === 'name');
        const where = offsetToPosition(
          asset.content,
          attr ? attr.valueSpan.start : node.openTagSpan.start,
        );
        const decl = {
          name: node.name,
          tag: node.localName,
          classes: node.classes,
          path: asset.path,
          line: where.line,
          column: where.column,
        };
        const list = elements.get(node.name);
        if (list) list.push(decl);
        else elements.set(node.name, [decl]);
      }
      for (const cls of node.classes) push(classesToDocs, cls, asset.path);
      for (const child of node.children) walk(child);
    };
    walk(doc.root);
  }
  return { docs, namesToDocs, elements, classesToDocs, allNames: [...namesToDocs.keys()], docCount: docs.size };
}

function buildUssIndex(assets: Array<{ path: string; content: string }>): UssIndex {
  const docs = new Map<string, ReturnType<typeof parseUss>>();
  const declaredClasses = new Map<string, string[]>();
  for (const asset of assets) {
    const sheet = parseUss(asset.content, asset.path);
    docs.set(asset.path, sheet);
    for (const rule of sheet.rules) {
      for (const selector of rule.selectors) {
        for (const part of selector.parts) {
          for (const simple of part.simples) {
            if (simple.kind === 'class') push(declaredClasses, simple.name, asset.path);
          }
        }
      }
    }
  }
  return { docs, declaredClasses, allClasses: [...declaredClasses.keys()], docCount: docs.size };
}

const WS = '/proj';

const HUD = `<ui:UXML xmlns:ui="UnityEngine.UIElements">
  <ui:VisualElement name="root" class="hud">
    <ui:Label name="hp-bar" class="hud__bar" />
    <ui:Button name="play-button" />
  </ui:VisualElement>
</ui:UXML>`;

const THEME = `.hud { flex-grow: 1; }
.hud__bar { color: red; }`;

function snapshot(over: Partial<UiToolkitSnapshot> = {}): UiToolkitSnapshot {
  const csRefs: CsUiRefIndex = {
    assignedNames: new Set(),
    referencedClasses: new Set(),
    scannedFiles: 3,
    loaded: true,
  };
  return {
    uxml: buildUxmlIndex([{ path: `${WS}/Assets/UI/HUD.uxml`, content: HUD }]),
    uss: buildUssIndex([{ path: `${WS}/Assets/UI/Theme.uss`, content: THEME }]),
    csRefs,
    ...over,
  };
}

function deps(over: Partial<UiToolkitToolDeps> = {}): UiToolkitToolDeps {
  return {
    loadSnapshot: async () => snapshot(),
    findUsages: async () => [],
    ...over,
  };
}

async function run(params: object, over?: Partial<UiToolkitToolDeps>): Promise<string> {
  const tool = createUnityUiToolkitTool(WS, deps(over));
  const result = await tool.execute('id', params);
  return result.content[0]?.type === 'text' ? result.content[0].text : '';
}

describe('unity_ui_toolkit — inventory', () => {
  it('lists documents, stylesheets and every element name Q<T>() can resolve', async () => {
    const out = await run({});
    expect(out).toContain('Assets/UI/HUD.uxml');
    expect(out).toContain('Assets/UI/Theme.uss');
    expect(out).toContain('hp-bar');
    expect(out).toContain('play-button');
  });

  it('states the failure mode rather than just listing names', async () => {
    const out = await run({});
    expect(out).toContain('returns null');
    expect(out).toContain('throws only when that screen first opens');
  });

  it('tells a uGUI project it does not use UI Toolkit, so the wrong stack is not written', async () => {
    const empty = snapshot({ uxml: buildUxmlIndex([]), uss: buildUssIndex([]) });
    const out = await run({}, { loadSnapshot: async () => empty });
    expect(out).toContain('does not use UI Toolkit');
    expect(out).toContain('uGUI');
  });

  it('answers rather than throwing when the snapshot is cold', async () => {
    expect(await run({}, { loadSnapshot: async () => null })).toContain('No UI Toolkit snapshot');
  });

  it('degrades to a read-tool hint when the scan fails', async () => {
    const out = await run(
      {},
      {
        loadSnapshot: async () => {
          throw new Error('scan failed');
        },
      },
    );
    expect(out).toContain('read tool');
  });
});

describe('unity_ui_toolkit — one document', () => {
  it('renders the element tree with names and classes', async () => {
    const out = await run({ document: 'HUD.uxml' });
    expect(out).toContain('<Label name="hp-bar"');
    expect(out).toContain('class="hud"');
  });

  it('names the real documents when the requested one does not exist', async () => {
    const out = await run({ document: 'Missing.uxml' });
    expect(out).toContain('No .uxml matching "Missing.uxml"');
    expect(out).toContain('Assets/UI/HUD.uxml');
  });
});

describe('unity_ui_toolkit — resolving one element', () => {
  it('says where a declared element lives and what type to query it as', async () => {
    const out = await run({ element: 'hp-bar' });
    expect(out).toContain('Assets/UI/HUD.uxml');
    expect(out).toContain('root.Q<Label>("hp-bar")');
  });

  it('refuses a name nothing declares, and does not soften it', async () => {
    const out = await run({ element: 'nope-bar' });
    expect(out).toContain('Do NOT query it');
    expect(out).toContain('NullReferenceException');
  });

  it('offers a near match rather than only saying no', async () => {
    expect(await run({ element: 'hp-bax' })).toContain('Did you mean "hp-bar"');
  });

  it('accepts a built-in control part name instead of reporting it missing', async () => {
    // Rung 3 of the ladder: 21 of 208 real names in the measured corpus.
    expect(await run({ element: 'unity-text-input' })).toContain('built-in Unity control');
  });

  it('accepts a name the C# assigns at runtime', async () => {
    const withAssigned = snapshot({
      csRefs: {
        assignedNames: new Set(['runtime-row']),
        referencedClasses: new Set(),
        scannedFiles: 3,
        loaded: true,
      },
    });
    const out = await run({ element: 'runtime-row' }, { loadSnapshot: async () => withAssigned });
    expect(out).toContain('created at runtime');
  });

  it('refuses to judge at all while the C# walk is unfinished', async () => {
    const unscanned = snapshot({
      csRefs: { assignedNames: new Set(), referencedClasses: new Set(), scannedFiles: 0, loaded: false },
    });
    const out = await run({ element: 'nope-bar' }, { loadSnapshot: async () => unscanned });
    expect(out).toContain('unknown rather than absent');
    expect(out).not.toContain('Do NOT query it');
  });

  it('does not scan the project for usages unless asked', async () => {
    let called = false;
    await run(
      { element: 'hp-bar' },
      {
        findUsages: async () => {
          called = true;
          return [];
        },
      },
    );
    expect(called).toBe(false);
  });

  it('lists the handlers attached to an element when usages are requested', async () => {
    const usage: ElementUsage = {
      elementName: 'play-button',
      kind: 'clicked',
      event: 'clicked',
      handler: 'OnPlay',
      handlerLine: 40,
      filePath: `${WS}/Assets/Scripts/Menu.cs`,
      line: 22,
      column: 5,
      snippet: 'play.clicked += OnPlay;',
    };
    const out = await run({ element: 'play-button', usages: true }, { findUsages: async () => [usage] });
    expect(out).toContain('Assets/Scripts/Menu.cs:22');
    expect(out).toContain('on click → OnPlay()');
  });

  it('says so plainly when nothing reads a declared element', async () => {
    expect(await run({ element: 'hp-bar', usages: true })).toContain('No C# reads "hp-bar"');
  });
});

describe('unity_ui_toolkit — classes', () => {
  it('reports a class used in UXML that no stylesheet declares', async () => {
    const orphan = snapshot({
      uxml: buildUxmlIndex([
        { path: `${WS}/Assets/UI/HUD.uxml`, content: '<ui:UXML><ui:Label class="ghost" /></ui:UXML>' },
      ]),
    });
    const out = await run({ classes: true }, { loadSnapshot: async () => orphan });
    expect(out).toContain('declared nowhere');
    expect(out).toContain('ghost');
  });

  it('does not accuse a class the C# adds at runtime', () => {
    const s = snapshot({
      uxml: buildUxmlIndex([
        { path: `${WS}/Assets/UI/HUD.uxml`, content: '<ui:UXML><ui:Label class="ghost" /></ui:UXML>' },
      ]),
      csRefs: {
        assignedNames: new Set(),
        referencedClasses: new Set(['ghost']),
        scannedFiles: 3,
        loaded: true,
      },
    });
    expect(undeclaredClasses(s.uxml, s.uss, s.csRefs)).toEqual([]);
  });

  it('says both lists are provisional while the C# walk is unfinished', async () => {
    const unscanned = snapshot({
      csRefs: { assignedNames: new Set(), referencedClasses: new Set(), scannedFiles: 0, loaded: false },
    });
    expect(await run({ classes: true }, { loadSnapshot: async () => unscanned })).toContain(
      'provisional',
    );
  });
});

describe('pure analysis', () => {
  it('flags a CSS property USS does not implement', () => {
    const uss = buildUssIndex([{ path: 'a.uss', content: '.a { box-shadow: 0 0 1px red; }' }]);
    const problems = invalidUssProperties(uss);
    expect(problems).toHaveLength(1);
    expect(problems[0].property).toBe('box-shadow');
  });

  it('does not flag USS custom properties', () => {
    const uss = buildUssIndex([{ path: 'a.uss', content: '.a { --brand: red; }' }]);
    expect(invalidUssProperties(uss)).toEqual([]);
  });

  it('renderInventory surfaces a parse error on the document line', () => {
    const broken = buildUxmlIndex([{ path: 'a.uxml', content: '<ui:UXML><ui:Label>' }]);
    const uss = buildUssIndex([]);
    const csRefs: CsUiRefIndex = {
      assignedNames: new Set(),
      referencedClasses: new Set(),
      scannedFiles: 0,
      loaded: true,
    };
    expect(renderInventory(broken, uss, csRefs, WS)).toContain('PARSE ERROR');
  });
});
