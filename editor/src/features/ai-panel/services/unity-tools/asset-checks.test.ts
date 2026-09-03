// These four formats all fail the same way in Unity: silently. So the tests
// that matter are the two ends of that — a real break must be reported in terms
// that tell the agent what to do about it, and a case we cannot judge must
// produce nothing at all. A gate that cries wolf gets ignored, and an ignored
// gate is worse than none because it makes the write look checked.

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  checkUxml,
  checkUss,
  checkInputActions,
  checkAssetDocument,
  formatFindings,
  gateLabelFor,
  isCheckableAsset,
  type UxmlCheckContext,
} from './asset-checks';

const NO_CS_WALK: UxmlCheckContext = {
  declaredClasses: new Set(),
  csReferencedClasses: null,
  ussPaths: [],
};

function ctx(over: Partial<UxmlCheckContext> = {}): UxmlCheckContext {
  return { ...NO_CS_WALK, csReferencedClasses: new Set(), ...over };
}

describe('isCheckableAsset', () => {
  it('covers exactly the four extensions the analyzer gate ignores', () => {
    for (const f of ['a.uxml', 'a.uss', 'a.inputactions', 'a.asset']) {
      expect(isCheckableAsset(f)).toBe(true);
    }
    for (const f of ['a.cs', 'a.prefab', 'a.json', 'a.meta']) {
      expect(isCheckableAsset(f)).toBe(false);
    }
  });

  it('is case-insensitive, because Unity paths on Windows are', () => {
    expect(isCheckableAsset('Assets/UI/HUD.UXML')).toBe(true);
  });
});

describe('checkUxml', () => {
  const GOOD = `<ui:UXML xmlns:ui="UnityEngine.UIElements">
  <ui:VisualElement name="root" class="hud">
    <ui:Label name="hp" />
  </ui:VisualElement>
</ui:UXML>`;

  it('says nothing about a well-formed document', () => {
    expect(checkUxml(GOOD, ctx({ declaredClasses: new Set(['hud']) }))).toEqual([]);
  });

  it('reports an unclosed tag as a load failure, not a style nit', () => {
    const findings = checkUxml('<ui:UXML><ui:Label name="hp">', ctx());
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].code).toStartWith('uxml-');
    expect(findings.map((f) => f.message).join(' ')).toContain('fail to load');
  });

  it('reports a <Style src> that points at no stylesheet in the project', () => {
    const doc =
      '<ui:UXML xmlns:ui="UnityEngine.UIElements">' +
      '<Style src="project://database/Assets/UI/Missing.uss?fileID=1&amp;guid=abc&amp;type=3" />' +
      '</ui:UXML>';
    const findings = checkUxml(doc, ctx({ ussPaths: ['Assets/UI/Theme.uss'] }));
    expect(findings.some((f) => f.code === 'uxml-style-missing')).toBe(true);
  });

  it('accepts a <Style src> that resolves to a real stylesheet', () => {
    const doc =
      '<ui:UXML xmlns:ui="UnityEngine.UIElements">' +
      '<Style src="project://database/Assets/UI/Theme.uss?fileID=1&amp;guid=abc&amp;type=3" />' +
      '</ui:UXML>';
    expect(checkUxml(doc, ctx({ ussPaths: ['Assets/UI/Theme.uss'] }))).toEqual([]);
  });

  it('reports a class no stylesheet declares', () => {
    const findings = checkUxml(GOOD, ctx());
    expect(findings.some((f) => f.code === 'uxml-class-undeclared' && f.message.includes('hud'))).toBe(
      true,
    );
  });

  it('suppresses that when the C# adds the class at runtime', () => {
    const findings = checkUxml(GOOD, ctx({ csReferencedClasses: new Set(['hud']) }));
    expect(findings.some((f) => f.code === 'uxml-class-undeclared')).toBe(false);
  });

  it('stays silent about classes entirely while the C# walk is unfinished', () => {
    // A suppressor we have not finished evaluating must never become a report.
    const findings = checkUxml(GOOD, NO_CS_WALK);
    expect(findings.some((f) => f.code === 'uxml-class-undeclared')).toBe(false);
  });

  it('reports each undeclared class once, however often it appears', () => {
    const repeated = `<ui:UXML xmlns:ui="UnityEngine.UIElements">
      <ui:VisualElement class="row" /><ui:VisualElement class="row" /><ui:VisualElement class="row" />
    </ui:UXML>`;
    const findings = checkUxml(repeated, ctx()).filter((f) => f.code === 'uxml-class-undeclared');
    expect(findings).toHaveLength(1);
  });
});

describe('checkUss', () => {
  it('says nothing about properties USS implements', () => {
    expect(checkUss('.a { color: red; -unity-font-style: bold; }', 'a.uss')).toEqual([]);
  });

  it('reports a CSS property USS does not implement, with the remedy', () => {
    const findings = checkUss('.a { box-shadow: 0 0 4px black; }', 'a.uss');
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('uss-unknown-property');
    expect(findings[0].message).toContain('box-shadow');
    expect(findings[0].message).toContain('ignores it silently');
  });

  it('leaves USS custom properties alone — `--foo` is its own variable syntax', () => {
    expect(checkUss('.a { --brand-color: red; color: var(--brand-color); }', 'a.uss')).toEqual([]);
  });

  it('reports a repeated bad property once', () => {
    expect(checkUss('.a { float: left; } .b { float: right; }', 'a.uss')).toHaveLength(1);
  });
});

describe('checkInputActions', () => {
  const ASSET = {
    name: 'Controls',
    maps: [
      {
        name: 'Player',
        id: 'm1',
        actions: [
          { name: 'Jump', type: 'Button', id: 'a1' },
          { name: 'Fire', type: 'Button', id: 'a2' },
        ],
        bindings: [{ id: 'b1', path: '<Keyboard>/space', action: 'Jump' }],
      },
    ],
  };

  it('says nothing about a healthy asset', () => {
    expect(checkInputActions(JSON.stringify(ASSET))).toEqual([]);
  });

  it('treats an unparseable asset as the hard failure it is, and names the safe tool', () => {
    const findings = checkInputActions('{ "maps": [ ');
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('inputactions-parse');
    expect(findings[0].message).toContain('unity_input_edit');
  });

  it('reports an action starved by a binding conflict', () => {
    const clash = structuredClone(ASSET);
    clash.maps[0].bindings.push({ id: 'b2', path: '<Keyboard>/space', action: 'Fire' });
    const findings = checkInputActions(JSON.stringify(clash));
    expect(findings.some((f) => f.code === 'inputactions-starved')).toBe(true);
    expect(findings.map((f) => f.message).join(' ')).toContain('never fire');
  });
});

describe('checkAssetDocument', () => {
  it('treats an unreadable document as corruption and points at the safe writer', () => {
    const findings = checkAssetDocument(null);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('asset-parse');
    expect(findings[0].message).toContain('unity_asset_edit');
  });

  it('reports a MonoBehaviour document that lost its script link', () => {
    const findings = checkAssetDocument({ classId: '114', scriptGuid: null });
    expect(findings[0].code).toBe('asset-script-missing');
    expect(findings[0].message).toContain('Missing Script');
  });

  it('says nothing about an intact document', () => {
    expect(checkAssetDocument({ classId: '114', scriptGuid: 'abc' })).toEqual([]);
  });

  it('does not demand a script guid from a non-MonoBehaviour asset', () => {
    expect(checkAssetDocument({ classId: '78', scriptGuid: null })).toEqual([]);
  });
});

describe('result formatting', () => {
  it('labels the note by the format that was written', () => {
    expect(gateLabelFor('a.uxml')).toBe('Unity UXML');
    expect(gateLabelFor('a.uss')).toBe('Unity USS');
    expect(gateLabelFor('a.inputactions')).toBe('Unity input actions');
    expect(gateLabelFor('a.asset')).toBe('Unity asset');
  });

  it('matches the analyzer gate’s shape, so compaction protects it the same way', () => {
    const text = formatFindings('a.uss', [{ code: 'uss-unknown-property', message: 'nope' }]);
    expect(text).toContain('[Unity USS] 1 issue(s) introduced by this write');
    expect(text).toContain('fix them before finishing');
    expect(text).toContain('  • uss-unknown-property: nope');
  });
});

// One-line inputs prove the branches; realistic markup proves the parsers hold
// up against what Unity actually writes — entity-encoded `project://` style
// refs, BEM-ish class names, `-unity-*` properties and comments in both files.
// `fixtures/uitoolkit/` is the committed pair, so this runs in CI.
describe('against a realistic document/stylesheet pair', () => {
  const dir = path.resolve(import.meta.dir, '../../../../../fixtures/uitoolkit');
  const uxml = readFileSync(path.join(dir, 'HUD.uxml'), 'utf8');
  const uss = readFileSync(path.join(dir, 'Theme.uss'), 'utf8');

  const declared = new Set(
    ['hud', 'hud__panel', 'hud__label', 'hud__label--big', 'hud__bar', 'hud__button'],
  );

  it('parses the document without diagnostics', () => {
    const findings = checkUxml(uxml, {
      declaredClasses: declared,
      csReferencedClasses: new Set(),
      ussPaths: ['Assets/UI/Theme.uss'],
    });
    expect(findings.filter((f) => f.code.startsWith('uxml-unclosed'))).toEqual([]);
    expect(findings.filter((f) => f.code === 'uxml-style-missing')).toEqual([]);
  });

  it('finds exactly the two classes the stylesheet does not declare', () => {
    const findings = checkUxml(uxml, {
      declaredClasses: declared,
      csReferencedClasses: new Set(),
      ussPaths: ['Assets/UI/Theme.uss'],
    }).filter((f) => f.code === 'uxml-class-undeclared');
    const names = findings.map((f) => f.message.match(/class "([^"]+)"/)?.[1]).sort();
    expect(names).toEqual(['hud__button--ghost', 'hud__panel--left']);
  });

  it('resolves the entity-encoded project:// style ref against the real path', () => {
    // `&amp;` in a `<Style src>` is universal, not occasional — decoding it
    // wrong makes every stylesheet look missing.
    const missing = checkUxml(uxml, {
      declaredClasses: declared,
      csReferencedClasses: new Set(),
      ussPaths: [],
    }).filter((f) => f.code === 'uxml-style-missing');
    expect(missing).toHaveLength(1);
  });

  it('flags box-shadow and nothing else in the stylesheet', () => {
    const findings = checkUss(uss, 'Assets/UI/Theme.uss');
    expect(findings.map((f) => f.message.match(/"([^"]+)"/)?.[1])).toEqual(['box-shadow']);
  });

  it('accepts every -unity-* property, which is USS-only and not CSS', () => {
    const findings = checkUss(uss, 'Assets/UI/Theme.uss');
    expect(findings.some((f) => f.message.includes('-unity-'))).toBe(false);
  });
});
