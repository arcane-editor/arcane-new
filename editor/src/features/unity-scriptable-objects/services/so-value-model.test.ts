import { describe, it, expect } from 'bun:test';
import type { SoField, SoSchema, SoWidgetKind } from '../../unity-analyzers';
import type { SoAssetSnapshot, SoFieldValue, SoValueKind } from './asset-fields-client';
import { buildRows, toEdit, toMemberEdit } from './so-value-model';
import { encodeValue, encodeYamlString, decodeYamlString, enumLabel, toDisplay } from './so-value-format';

// Type-only imports: a feature barrel pulls runtime modules that touch
// `document` at load, and this runner has no DOM.

function field(name: string, widget: SoWidgetKind, over: Partial<SoField> = {}): SoField {
  return {
    name,
    csharpType: widget,
    bareType: widget,
    widget,
    isArray: false,
    elementType: null,
    elementWidget: null,
    header: null,
    tooltip: null,
    range: null,
    min: null,
    hiddenInInspector: false,
    serializeReference: false,
    formerNames: [],
    enumMembers: null,
    enumIsFlags: false,
    editable: true,
    declLine: 1,
    nameOffset: 0,
    declSpan: { start: 0, end: 0 },
    attributes: [],
    ...over,
  };
}

function value(key: string, raw: string, kind: SoValueKind = 'scalar', over: Partial<SoFieldValue> = {}): SoFieldValue {
  return { key, raw, kind, editable: true, reason: null, members: [], ...over };
}

function schemaOf(fields: SoField[]): SoSchema {
  return {
    className: 'WeaponDef',
    baseTypes: ['ScriptableObject'],
    baseKind: 'scriptableObject',
    unresolvedBase: null,
    menuPath: null,
    defaultFileName: null,
    fields,
    groups: [],
  };
}

function snapshotOf(fields: SoFieldValue[]): SoAssetSnapshot {
  return {
    documentFileId: '11400000',
    classId: '114',
    scriptGuid: 'abc',
    fields,
    sha1: 'deadbeef',
  };
}

const damage = field('damage', 'float');

describe('buildRows — states', () => {
  it('binds a field present under its own name', () => {
    const rows = buildRows(schemaOf([damage]), snapshotOf([value('damage', '12')]));
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('bound');
    expect(rows[0].editable).toBe(true);
    expect(rows[0].yamlKey).toBe('damage');
  });

  it('reports a field the asset does not have yet as missing, and not editable', () => {
    const rows = buildRows(schemaOf([damage]), snapshotOf([]));
    expect(rows[0].state).toBe('missing');
    expect(rows[0].value).toBeNull();
    expect(rows[0].editable).toBe(false);
  });

  it('binds through a FormerlySerializedAs name and says so', () => {
    const renamed = field('damage', 'float', { formerNames: ['dmg'] });
    const rows = buildRows(schemaOf([renamed]), snapshotOf([value('dmg', '12')]));
    expect(rows[0].state).toBe('migrated');
    expect(rows[0].yamlKey).toBe('dmg');
    expect(rows[0].migratedFrom).toBe('dmg');
    expect(rows[0].editable).toBe(true);
  });

  it('prefers the current key over a former one', () => {
    const renamed = field('damage', 'float', { formerNames: ['dmg'] });
    const rows = buildRows(
      schemaOf([renamed]),
      snapshotOf([value('damage', '9'), value('dmg', '12')]),
    );
    expect(rows[0].state).toBe('bound');
    expect(rows[0].yamlKey).toBe('damage');
    // The leftover key is surfaced rather than hidden.
    expect(rows.find((r) => r.yamlKey === 'dmg')?.state).toBe('unmapped');
  });

  it('degrades to read-only when the shape contradicts the type', () => {
    // The schema says float; the file holds an object reference. Writing a
    // scalar here would silently unassign the reference.
    const rows = buildRows(schemaOf([damage]), snapshotOf([value('damage', '{fileID: 0}', 'inlineMap')]));
    expect(rows[0].state).toBe('degraded');
    expect(rows[0].editable).toBe(false);
  });

  it('surfaces a key the class no longer declares', () => {
    const rows = buildRows(schemaOf([damage]), snapshotOf([value('damage', '1'), value('legacyKick', '3')]));
    expect(rows.map((r) => r.state)).toEqual(['bound', 'unmapped']);
    expect(rows[1].editable).toBe(false);
  });

  it('hides Unity bookkeeping keys', () => {
    const rows = buildRows(
      schemaOf([damage]),
      snapshotOf([value('damage', '1'), value('m_Name', 'X'), value('serializedVersion', '2')]),
    );
    expect(rows).toHaveLength(1);
  });

  it('keeps schema order regardless of file order', () => {
    const a = field('a', 'int');
    const b = field('b', 'int');
    const rows = buildRows(schemaOf([a, b]), snapshotOf([value('b', '2'), value('a', '1')]));
    expect(rows.map((r) => r.yamlKey)).toEqual(['a', 'b']);
  });

  it('respects a value the reader marked non-editable', () => {
    const rows = buildRows(
      schemaOf([field('note', 'string')]),
      snapshotOf([value('note', 'x', 'opaque', { editable: false, reason: 'blockScalar' })]),
    );
    expect(rows[0].editable).toBe(false);
  });

  it('never marks a non-editable schema field editable', () => {
    const arr = field('mods', 'unknown', { isArray: true, editable: false });
    const rows = buildRows(schemaOf([arr]), snapshotOf([value('mods', '[]', 'inlineSeq')]));
    expect(rows[0].editable).toBe(false);
  });
});

describe('toEdit', () => {
  const bound = () => buildRows(schemaOf([damage]), snapshotOf([value('damage', '12')]))[0];

  it('produces an edit carrying the current value as the concurrency guard', () => {
    const edit = toEdit(bound(), '42', '11400000');
    expect(edit).toEqual({
      fileId: '11400000',
      path: 'damage',
      value: '42',
      expected: '12',
    });
  });

  it('returns null for a no-op, so nothing reaches disk', () => {
    expect(toEdit(bound(), '12', '11400000')).toBeNull();
  });

  it('returns null for an invalid draft', () => {
    expect(toEdit(bound(), 'not a number', '11400000')).toBeNull();
  });

  it('returns null for a non-editable row', () => {
    const missing = buildRows(schemaOf([damage]), snapshotOf([]))[0];
    expect(toEdit(missing, '5', '11400000')).toBeNull();
    const unmapped = buildRows(schemaOf([]), snapshotOf([value('old', '1')]))[0];
    expect(toEdit(unmapped, '5', '11400000')).toBeNull();
  });

  it('writes through the migrated key, not the new one', () => {
    const renamed = field('damage', 'float', { formerNames: ['dmg'] });
    const row = buildRows(schemaOf([renamed]), snapshotOf([value('dmg', '12')]))[0];
    expect(toEdit(row, '42', '11400000')?.path).toBe('dmg');
  });
});

describe('toMemberEdit', () => {
  const colour = field('tint', 'color');
  const row = () =>
    buildRows(
      schemaOf([colour]),
      snapshotOf([
        value('tint', '{r: 1, g: 0.5, b: 0, a: 1}', 'inlineMap', {
          members: [
            { name: 'r', raw: '1' },
            { name: 'g', raw: '0.5' },
            { name: 'b', raw: '0' },
            { name: 'a', raw: '1' },
          ],
        }),
      ]),
    )[0];

  it('edits one member by path', () => {
    expect(toMemberEdit(row(), 'g', '0.75', '11400000')).toEqual({
      fileId: '11400000',
      path: 'tint.g',
      value: '0.75',
      expected: '0.5',
    });
  });

  it('returns null for an unchanged member', () => {
    expect(toMemberEdit(row(), 'g', '0.5', '11400000')).toBeNull();
  });

  it('returns null for an unknown member or a non-numeric draft', () => {
    expect(toMemberEdit(row(), 'z', '1', '11400000')).toBeNull();
    expect(toMemberEdit(row(), 'g', 'abc', '11400000')).toBeNull();
  });
});

describe('encodeValue', () => {
  it('writes a bool as Unity does', () => {
    const b = field('f', 'bool');
    expect(encodeValue('true', b)).toEqual({ ok: true, raw: '1' });
    expect(encodeValue('false', b)).toEqual({ ok: true, raw: '0' });
    expect(encodeValue('maybe', b).ok).toBe(false);
  });

  it('writes an enum as its ordinal, never its name', () => {
    const e = field('f', 'enum', {
      enumMembers: [
        { name: 'Common', value: 0 },
        { name: 'Epic', value: 2 },
      ],
    });
    expect(encodeValue('Epic', e)).toEqual({ ok: true, raw: '2' });
    expect(encodeValue('2', e)).toEqual({ ok: true, raw: '2' });
    expect(encodeValue('Nope', e).ok).toBe(false);
  });

  it('preserves a float the user did not change in value', () => {
    // `12` must not become `12.0` — that would rewrite the file on a no-op.
    expect(encodeValue('12', damage)).toEqual({ ok: true, raw: '12' });
    expect(encodeValue('1.350', damage)).toEqual({ ok: true, raw: '1.350' });
  });

  it('rejects a fractional int', () => {
    expect(encodeValue('1.5', field('f', 'int')).ok).toBe(false);
  });

  it('clamps to [Range]', () => {
    const ranged = field('f', 'float', { range: { min: 0, max: 50 } });
    expect(encodeValue('99', ranged)).toEqual({ ok: true, raw: '50' });
    expect(encodeValue('-5', ranged)).toEqual({ ok: true, raw: '0' });
  });

  it('clamps to [Min]', () => {
    expect(encodeValue('-5', field('f', 'int', { min: 0 }))).toEqual({ ok: true, raw: '0' });
  });

  it('quotes a string only when it needs it', () => {
    const s = field('f', 'string');
    expect(encodeValue('Iron Sword', s)).toEqual({ ok: true, raw: 'Iron Sword' });
    expect(encodeValue("Sword 'of' Truth", s)).toEqual({ ok: true, raw: "'Sword ''of'' Truth'" });
    expect(encodeValue('', s)).toEqual({ ok: true, raw: "''" });
  });

  it('refuses a widget it cannot write', () => {
    expect(encodeValue('x', field('f', 'unknown')).ok).toBe(false);
  });
});

describe('yaml string round-trip', () => {
  it('decodes what it encodes', () => {
    for (const s of ['', 'plain', "Sword 'of' Truth", '#hash', 'a: b', 'yes', ' lead', '123']) {
      expect(decodeYamlString(encodeYamlString(s))).toBe(s);
    }
  });
});

describe('display helpers', () => {
  it('shows a Unity bool as true/false', () => {
    const b = field('f', 'bool');
    expect(toDisplay('1', b)).toBe('true');
    expect(toDisplay('0', b)).toBe('false');
  });

  it('unquotes a string for display', () => {
    expect(toDisplay("'Sword ''of'' Truth'", field('f', 'string'))).toBe("Sword 'of' Truth");
  });

  it('labels an enum ordinal, falling back to the number', () => {
    const e = field('f', 'enum', { enumMembers: [{ name: 'Epic', value: 2 }] });
    expect(enumLabel('2', e)).toBe('Epic');
    expect(enumLabel('9', e)).toBe('9');
  });
});
