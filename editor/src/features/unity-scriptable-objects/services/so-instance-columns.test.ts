import { describe, it, expect } from 'bun:test';
import type { SoField, SoSchema, SoWidgetKind } from '../../unity-analyzers';
import type { AssetUsageEntry } from '../../unity-context';
import {
  cellValue,
  formatCell,
  instanceRows,
  pickColumns,
  MAX_INSTANCE_COLUMNS,
} from './so-instance-columns';

// Type-only imports on purpose: a feature barrel pulls runtime modules that
// touch `document` at load, and this runner has no DOM. Fixtures are built as
// literals, the same shape `scene-diff-model.test.ts` uses.

function baseField(name: string, widget: SoWidgetKind, over: Partial<SoField> = {}): SoField {
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

const displayName = baseField('displayName', 'string');
const icon = baseField('icon', 'objectRef');
const rarity = baseField('rarity', 'enum', {
  enumMembers: [
    { name: 'Common', value: 0 },
    { name: 'Rare', value: 1 },
    { name: 'Epic', value: 2 },
  ],
});
const damage = baseField('damage', 'float');
const dropsAmmo = baseField('dropsAmmo', 'bool');
const spread = baseField('spread', 'float', { formerNames: ['dmg'] });
const offset = baseField('offset', 'vector3');
const projectile = baseField('projectile', 'objectRef');
const internalId = baseField('internalId', 'int', { hiddenInInspector: true });
const mods = baseField('mods', 'unknown', { isArray: true, elementType: 'WeaponMod' });

const schema: SoSchema = {
  className: 'WeaponDef',
  baseTypes: ['ScriptableObject'],
  baseKind: 'scriptableObject',
  unresolvedBase: null,
  menuPath: 'Combat/Weapon',
  defaultFileName: 'New Weapon',
  fields: [displayName, icon, rarity, damage, dropsAmmo, spread, offset, projectile, internalId, mods],
  groups: [],
};

function entry(over: Partial<AssetUsageEntry> = {}): AssetUsageEntry {
  return {
    kind: 'scriptableObject',
    assetName: 'Sword',
    assetPath: 'Assets/Data/Sword.asset',
    refCount: 1,
    gameObjects: [],
    isInstance: true,
    fields: [],
    ...over,
  };
}

describe('pickColumns', () => {
  it('takes scalar fields in declaration order', () => {
    expect(pickColumns(schema).map((f) => f.name)).toEqual([
      'displayName', 'rarity', 'damage', 'dropsAmmo',
    ]);
  });

  it('caps the column count', () => {
    expect(pickColumns(schema).length).toBeLessThanOrEqual(MAX_INSTANCE_COLUMNS);
    expect(pickColumns(schema, 2).map((f) => f.name)).toEqual(['displayName', 'rarity']);
  });

  it('skips object references, structs, arrays and hidden fields', () => {
    const names = pickColumns(schema, 99).map((f) => f.name);
    expect(names).not.toContain('icon');
    expect(names).not.toContain('projectile');
    expect(names).not.toContain('offset');
    expect(names).not.toContain('internalId');
    expect(names).not.toContain('mods');
  });

  it('handles a missing schema', () => {
    expect(pickColumns(null)).toEqual([]);
  });
});

describe('cellValue', () => {
  it('reads the value the skim reported', () => {
    const e = entry({ fields: [{ label: 'damage', value: '12.5' }] });
    expect(cellValue(e, damage)).toBe('12.5');
  });

  it('returns null — never a neighbouring value — when the skim dropped the field', () => {
    // The skim caps at 8 fields and drops object refs, so this is the common
    // case, not an edge case. Guessing here would show one weapon's number
    // against another weapon's name.
    const e = entry({ fields: [{ label: 'displayName', value: 'Sword' }] });
    expect(cellValue(e, damage)).toBeNull();
  });

  it('falls back to a FormerlySerializedAs key', () => {
    const e = entry({ fields: [{ label: 'dmg', value: '3' }] });
    expect(cellValue(e, spread)).toBe('3');
  });

  it('prefers the current key over the former one', () => {
    const e = entry({ fields: [{ label: 'spread', value: '9' }, { label: 'dmg', value: '3' }] });
    expect(cellValue(e, spread)).toBe('9');
  });

  it('handles an entry with no fields at all', () => {
    expect(cellValue(entry({ fields: undefined }), damage)).toBeNull();
  });
});

describe('formatCell', () => {
  it('renders a missing value as an em dash', () => {
    expect(formatCell(null, damage)).toBe('—');
  });

  it('renders a Unity bool as true/false', () => {
    expect(formatCell('0', dropsAmmo)).toBe('false');
    expect(formatCell('1', dropsAmmo)).toBe('true');
  });

  it('renders an enum ordinal as its member name', () => {
    expect(formatCell('0', rarity)).toBe('Common');
    expect(formatCell('2', rarity)).toBe('Epic');
  });

  it('passes an unrecognised enum ordinal through rather than guessing', () => {
    expect(formatCell('99', rarity)).toBe('99');
  });

  it('passes scalars through untouched', () => {
    expect(formatCell('12.5', damage)).toBe('12.5');
    expect(formatCell('Sword', displayName)).toBe('Sword');
  });
});

describe('instanceRows', () => {
  it('keeps only ScriptableObject instances', () => {
    const rows = instanceRows([
      entry({ assetName: 'A' }),
      entry({ assetName: 'B', isInstance: false }),
      entry({ assetName: 'C', kind: 'prefab' }),
    ]);
    expect(rows.map((r) => r.assetName)).toEqual(['A']);
  });

  it('handles null', () => {
    expect(instanceRows(null)).toEqual([]);
  });
});
