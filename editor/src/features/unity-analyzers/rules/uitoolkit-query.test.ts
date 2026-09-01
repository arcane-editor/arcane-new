import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { uitoolkitQueryRule } from './uitoolkit-query';
import { scanCSharp } from '../services/csharp-scan';
import {
  __setUiToolkitIndexesForTest,
  buildUxmlIndex,
  type CsUiRefIndex,
} from '../services/uitoolkit-cache';

const MAIN_MENU = `<ui:UXML xmlns:ui="UnityEngine.UIElements">
  <ui:VisualElement name="root">
    <ui:Button name="play-button" class="btn" />
    <ui:Button name="quit-btn" class="btn" />
  </ui:VisualElement>
</ui:UXML>`;

const INDEX = buildUxmlIndex([{ path: 'Assets/UI/MainMenu.uxml', content: MAIN_MENU }]);

function loadedRefs(names: string[] = []): CsUiRefIndex {
  return {
    assignedNames: new Set(names),
    referencedClasses: new Set(),
    scannedFiles: 1,
    loaded: true,
  };
}

function run(code: string) {
  return uitoolkitQueryRule.run(scanCSharp(code), {
    model: null,
    filePath: 'Assets/Scripts/MainMenu.cs',
    unityVersion: '6000.3.11f1',
    monaco: null,
  });
}

const codes = (fs: ReturnType<typeof run>) => fs.map((f) => f.code);

beforeEach(() => {
  __setUiToolkitIndexesForTest({ uxml: INDEX, csRefs: loadedRefs() });
});

afterEach(() => {
  __setUiToolkitIndexesForTest({ uxml: null, csRefs: undefined });
});

// A false positive here is noise on every valid UI script, so the silent cases
// come first and outnumber the reporting ones.
describe('uitoolkit-query — when it must stay silent', () => {
  it('says nothing without a snapshot', () => {
    __setUiToolkitIndexesForTest({ uxml: null });
    expect(run('root.Q<Button>("anything");')).toEqual([]);
  });

  it('says nothing in a project with no .uxml at all', () => {
    __setUiToolkitIndexesForTest({ uxml: buildUxmlIndex([]) });
    expect(run('root.Q<Button>("anything");')).toEqual([]);
  });

  it('says nothing while the C# walk is still running', () => {
    // Rung 4 is a suppressor; reporting before it lands means reporting names
    // that have not finished being checked.
    __setUiToolkitIndexesForTest({
      uxml: INDEX,
      csRefs: { assignedNames: new Set(), referencedClasses: new Set(), scannedFiles: 0, loaded: false },
    });
    expect(run('root.Q<Button>("nowhere");')).toEqual([]);
  });

  it('says nothing when the name resolves', () => {
    expect(run('root.Q<Button>("play-button");')).toEqual([]);
  });

  it('says nothing for a built-in control part', () => {
    // The measured false-positive class. All 21 unmatched names in the corpus
    // were of this kind, so this test is the one that matters most.
    expect(run('scroller = root.Q("unity-content-container");')).toEqual([]);
    expect(run('mark = root.Q("unity-checkmark");')).toEqual([]);
  });

  it('says nothing for a name assigned from C# elsewhere', () => {
    __setUiToolkitIndexesForTest({ uxml: INDEX, csRefs: loadedRefs(['runtime-made']) });
    expect(run('root.Q<Label>("runtime-made");')).toEqual([]);
  });

  it('says nothing for a class-only query', () => {
    expect(run('root.Q<Button>(className: "primary");')).toEqual([]);
  });

  it('says nothing for a type-only query', () => {
    expect(run('root.Q<ScrollView>();')).toEqual([]);
  });

  it('says nothing about a query inside a comment', () => {
    expect(run('// root.Q<Button>("ghost");')).toEqual([]);
  });

  it('says nothing when the argument is not a literal', () => {
    expect(run('root.Q<Button>(this.buttonName);')).toEqual([]);
  });
});

describe('uitoolkit-query — when it reports', () => {
  it('flags a name no document declares', () => {
    const found = run('root.Q<Button>("play-btn").clicked += Go;');
    expect(codes(found)).toEqual(['UNITY0501']);
    expect(found[0].severity).toBe('warning');
  });

  it('suggests the near match', () => {
    expect(run('root.Q<Button>("play-btn");')[0].message).toContain("'play-button'");
  });

  it('never raises an error, only a warning', () => {
    // A heuristic over data the compiler cannot see. A false error costs more
    // than a missed warning, so the severity ceiling is deliberate.
    for (const f of run('root.Q<Button>("nope-a"); root.Q<Button>("nope-b");')) {
      expect(f.severity).toBe('warning');
    }
  });

  it('underlines the literal, quotes included', () => {
    const code = 'var b = root.Q<Button>("play-btn");';
    const f = run(code)[0];
    expect(code.slice(f.start, f.end)).toBe('"play-btn"');
  });

  it('reports each bad query once', () => {
    expect(run('root.Q<Button>("nope-a");\nroot.Q<Label>("nope-b");')).toHaveLength(2);
  });
});
