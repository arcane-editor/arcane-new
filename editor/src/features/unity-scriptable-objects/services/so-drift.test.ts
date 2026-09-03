import { describe, it, expect } from 'bun:test';
import type { SoField, SoSchema, SoWidgetKind } from '../../unity-analyzers';
import type { SoAssetSnapshot, SoFieldValue } from './asset-fields-client';
import { computeDrift, defaultRawFor, describeDrift, fixEditsFor } from './so-drift';

function field(name: string, widget: SoWidgetKind, over: Partial<SoField> = {}): SoField {
  return {
    name, csharpType: widget, bareType: widget, widget,
    isArray: false, elementType: null, elementWidget: null,
    header: null, tooltip: null, range: null, min: null,
    hiddenInInspector: false, serializeReference: false, formerNames: [],
    enumMembers: null, enumIsFlags: false, editable: true,
    declLine: 1, nameOffset: 0, declSpan: { start: 0, end: 0 }, attributes: [],
    ...over,
  };
}

function schemaOf(fields: SoField[]): SoSchema {
  return {
    className: 'WeaponDef', baseTypes: ['ScriptableObject'], baseKind: 'scriptableObject',
    unresolvedBase: null, menuPath: null, defaultFileName: null, fields, groups: [],
  };
}

function snap(pairs: Array<[string, string]>): SoAssetSnapshot {
  const fields: SoFieldValue[] = pairs.map(([key, raw]) => ({
    key, raw, kind: 'scalar', editable: true, reason: null, members: [],
  }));
  return { documentFileId: '11400000', classId: '114', scriptGuid: 'g', fields, sha1: 'h' };
}

function instance(name: string, pairs: Array<[string, string]>) {
  return { path: `Assets/Data/${name}.asset`, name, snapshot: snap(pairs) };
}

const damage = field('damage', 'float');

describe('computeDrift — renamed', () => {
  const renamed = field('damage', 'float', { formerNames: ['dmg'] });

  it('reports assets still storing the old key', () => {
    const findings = computeDrift({
      schema: schemaOf([renamed]),
      instances: [instance('Sword', [['dmg', '14.5']]), instance('Axe', [['damage', '9']])],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('renamed');
    expect(findings[0].formerKey).toBe('dmg');
    expect(findings[0].assets.map((a) => a.name)).toEqual(['Sword']);
    expect(findings[0].assets[0].currentRaw).toBe('14.5');
  });

  it('does not also report the old key as an orphan', () => {
    // Reporting both would invite deleting the value before it has moved.
    const findings = computeDrift({
      schema: schemaOf([renamed]),
      instances: [instance('Sword', [['dmg', '14.5']])],
    });
    expect(findings.map((f) => f.kind)).toEqual(['renamed']);
  });

  it('is silent once every asset has migrated', () => {
    const findings = computeDrift({
      schema: schemaOf([renamed]),
      instances: [instance('Sword', [['damage', '14.5']])],
    });
    expect(findings).toHaveLength(0);
  });
});

describe('computeDrift — added', () => {
  it('reports assets missing a newly declared field', () => {
    const findings = computeDrift({
      schema: schemaOf([damage, field('armorPierce', 'float')]),
      instances: [instance('Sword', [['damage', '1']]), instance('Axe', [['damage', '2'], ['armorPierce', '0.3']])],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('added');
    expect(findings[0].assets.map((a) => a.name)).toEqual(['Sword']);
  });

  it('anchors the insertion after the last field actually present', () => {
    const findings = computeDrift({
      schema: schemaOf([damage, field('armorPierce', 'float')]),
      instances: [instance('Sword', [['damage', '1']])],
    });
    expect(findings[0].assets[0].insertAfter).toBe('damage');
  });

  it('is not fixable when no sensible default exists', () => {
    // A Vector3 or an object reference has no single right literal; leaving the
    // key absent lets Unity supply the real default.
    const findings = computeDrift({
      schema: schemaOf([field('offset', 'vector3')]),
      instances: [instance('Sword', [])],
    });
    expect(findings[0].fixable).toBe(false);
  });
});

describe('computeDrift — orphan', () => {
  it('reports a key the class no longer declares', () => {
    const findings = computeDrift({
      schema: schemaOf([damage]),
      instances: [instance('Sword', [['damage', '1'], ['legacyKick', '3']])],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('orphan');
    expect(findings[0].key).toBe('legacyKick');
  });

  it('ignores Unity bookkeeping', () => {
    const findings = computeDrift({
      schema: schemaOf([damage]),
      instances: [instance('Sword', [['damage', '1'], ['m_Name', 'Sword'], ['serializedVersion', '2']])],
    });
    expect(findings).toHaveLength(0);
  });

  it('groups the same orphan key across assets', () => {
    const findings = computeDrift({
      schema: schemaOf([damage]),
      instances: [
        instance('Sword', [['damage', '1'], ['legacyKick', '3']]),
        instance('Axe', [['damage', '2'], ['legacyKick', '4']]),
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].assets).toHaveLength(2);
  });
});

describe('computeDrift — ordering and quiet cases', () => {
  it('puts renames first, because only they destroy data', () => {
    const renamed = field('damage', 'float', { formerNames: ['dmg'] });
    const findings = computeDrift({
      schema: schemaOf([renamed, field('armorPierce', 'float')]),
      instances: [instance('Sword', [['dmg', '1'], ['legacyKick', '2']])],
    });
    expect(findings.map((f) => f.kind)).toEqual(['renamed', 'added', 'orphan']);
  });

  it('reports nothing when the class and the assets agree', () => {
    expect(
      computeDrift({
        schema: schemaOf([damage]),
        instances: [instance('Sword', [['damage', '1']])],
      }),
    ).toHaveLength(0);
  });

  it('reports nothing when there are no instances', () => {
    expect(computeDrift({ schema: schemaOf([damage]), instances: [] })).toHaveLength(0);
  });
});

describe('fixEditsFor', () => {
  it('renames as an insert carrying the old value plus a guarded delete', () => {
    const renamed = field('damage', 'float', { formerNames: ['dmg'] });
    const [finding] = computeDrift({
      schema: schemaOf([renamed]),
      instances: [instance('Sword', [['dmg', '14.5']])],
    });
    const edits = fixEditsFor(finding, renamed).get('Assets/Data/Sword.asset')!;
    expect(edits).toEqual([
      {
        fileId: '11400000',
        path: 'damage',
        value: '14.5',
        ifMissing: { mode: 'insertAfter', anchor: 'dmg' },
      },
      { fileId: '11400000', path: 'dmg', value: '', remove: true, expected: '14.5' },
    ]);
  });

  it('writes a default for an added field', () => {
    const f = field('armorPierce', 'float');
    const [finding] = computeDrift({
      schema: schemaOf([damage, f]),
      instances: [instance('Sword', [['damage', '1']])],
    });
    expect(fixEditsFor(finding, f).get('Assets/Data/Sword.asset')).toEqual([
      {
        fileId: '11400000',
        path: 'armorPierce',
        value: '0',
        ifMissing: { mode: 'insertAfter', anchor: 'damage' },
      },
    ]);
  });

  it('strips an orphan key', () => {
    const [finding] = computeDrift({
      schema: schemaOf([damage]),
      instances: [instance('Sword', [['damage', '1'], ['legacyKick', '3']])],
    });
    expect(fixEditsFor(finding, null).get('Assets/Data/Sword.asset')).toEqual([
      { fileId: '11400000', path: 'legacyKick', value: '', remove: true },
    ]);
  });

  it('produces nothing for an unfixable finding', () => {
    const f = field('offset', 'vector3');
    const [finding] = computeDrift({
      schema: schemaOf([f]),
      instances: [instance('Sword', [])],
    });
    expect(fixEditsFor(finding, f).size).toBe(0);
  });
});

describe('defaultRawFor', () => {
  it('uses Unity spellings', () => {
    expect(defaultRawFor(field('a', 'int'))).toBe('0');
    expect(defaultRawFor(field('a', 'bool'))).toBe('0');
    expect(defaultRawFor(field('a', 'string'))).toBe("''");
  });

  it('prefers the zero member of an enum', () => {
    const e = field('a', 'enum', {
      enumMembers: [{ name: 'Rare', value: 3 }, { name: 'Common', value: 0 }],
    });
    expect(defaultRawFor(e)).toBe('0');
  });

  it('refuses to invent a structured default', () => {
    expect(defaultRawFor(field('a', 'vector3'))).toBeNull();
    expect(defaultRawFor(field('a', 'objectRef'))).toBeNull();
  });
});

describe('describeDrift', () => {
  it('names the consequence, not just the condition', () => {
    const renamed = field('damage', 'float', { formerNames: ['dmg'] });
    const [finding] = computeDrift({
      schema: schemaOf([renamed]),
      instances: [instance('Sword', [['dmg', '1']])],
    });
    expect(describeDrift(finding)).toContain('reverts to the default');
  });
});
