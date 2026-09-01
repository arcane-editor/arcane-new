import { describe, it, expect } from 'bun:test';
import { scanCSharp } from './csharp-scan';
import {
  buildSoSchema,
  classBaseKind,
  elementTypeOf,
  fieldGroups,
  widgetForType,
  type SoSchema,
} from './so-schema';
import { UNITY_SERIALIZABLE_STRUCTS, WIDGET_BY_TYPE } from '../data/unity-knowledge';

function run(code: string, className?: string): SoSchema {
  const schema = buildSoSchema(scanCSharp(code), className ? { className } : undefined);
  if (!schema) throw new Error('no schema built');
  return schema;
}

const WEAPON = `using System;
using UnityEngine;
using UnityEngine.Serialization;

public enum Rarity { Common, Rare, Epic, Legendary }

[Flags]
public enum Element { None = 0, Kinetic = 1 << 0, Ember = 1 << 1, Void = 1 << 2 }

[Serializable]
public class WeaponMod { public int id; }

[CreateAssetMenu(fileName = "New Weapon", menuName = "Combat/Weapon")]
public class WeaponDef : ScriptableObject
{
    [Header("Identity")]
    [SerializeField] private string displayName;
    [SerializeField] private Sprite icon;
    [SerializeField] private Rarity rarity;

    [Header("Ballistics")]
    [Tooltip("Damage per shot, before armour")]
    [Range(0f, 50f)]
    [SerializeField] private float damage;

    [FormerlySerializedAs("dmg")]
    [FormerlySerializedAs("rawDamage")]
    [SerializeField] private float fireRate;

    [Min(0)]
    [SerializeField] private int magazineSize;

    [SerializeField] private Element element;
    [SerializeField] private Color tracerColor;
    [SerializeField] private Vector3 muzzleOffset;
    [SerializeField] private GameObject projectile;

    [SerializeField] private List<WeaponMod> mods;
    [SerializeField] private WeaponMod[] presets;
    [SerializeField] private WeaponMod inlineMod;

    [HideInInspector]
    [SerializeField] private int internalId;

    [SerializeReference]
    [SerializeField] private object behaviour;

    [SerializeField] private AnimationCurve falloff;

    private int notSerialized;
    public static int Shared;
}
`;

describe('buildSoSchema — class identity', () => {
  const schema = run(WEAPON);

  it('picks the ScriptableObject class', () => {
    expect(schema.className).toBe('WeaponDef');
    expect(schema.baseKind).toBe('scriptableObject');
  });

  it('reads the CreateAssetMenu named arguments', () => {
    expect(schema.menuPath).toBe('Combat/Weapon');
    expect(schema.defaultFileName).toBe('New Weapon');
  });

  it('returns null for a document with no class', () => {
    expect(buildSoSchema(scanCSharp('using UnityEngine;'))).toBeNull();
  });

  it('never throws on garbage', () => {
    for (const junk of ['', '{{{', 'class', 'public class A : {']) {
      expect(() => buildSoSchema(scanCSharp(junk))).not.toThrow();
    }
  });
});

describe('buildSoSchema — field selection', () => {
  const schema = run(WEAPON);
  const names = schema.fields.map((f) => f.name);

  it('keeps declaration order, which is the order Unity serializes in', () => {
    expect(names.slice(0, 4)).toEqual(['displayName', 'icon', 'rarity', 'damage']);
  });

  it('excludes non-serialized and static fields', () => {
    expect(names).not.toContain('notSerialized');
    expect(names).not.toContain('Shared');
  });

  it('includes a [HideInInspector] field, which Unity still serializes', () => {
    expect(names).toContain('internalId');
    expect(schema.fields.find((f) => f.name === 'internalId')!.hiddenInInspector).toBe(true);
  });

  it('does not pull in fields from another class in the same file', () => {
    expect(names).not.toContain('id');
  });
});

describe('buildSoSchema — attribute metadata', () => {
  const schema = run(WEAPON);
  const f = (n: string) => schema.fields.find((x) => x.name === n)!;

  it('captures Range', () => {
    expect(f('damage').range).toEqual({ min: 0, max: 50 });
  });

  it('captures Tooltip text', () => {
    expect(f('damage').tooltip).toBe('Damage per shot, before armour');
  });

  it('captures Min', () => {
    expect(f('magazineSize').min).toBe(0);
  });

  it('collects every FormerlySerializedAs name', () => {
    expect(f('fireRate').formerNames).toEqual(['dmg', 'rawDamage']);
  });

  it('leaves range null when the attribute is absent', () => {
    expect(f('magazineSize').range).toBeNull();
  });
});

describe('buildSoSchema — widget resolution', () => {
  const schema = run(WEAPON);
  const w = (n: string) => schema.fields.find((x) => x.name === n)!.widget;

  it('maps primitives', () => {
    expect(w('displayName')).toBe('string');
    expect(w('damage')).toBe('float');
    expect(w('magazineSize')).toBe('int');
  });

  it('maps Unity structs', () => {
    expect(w('tracerColor')).toBe('color');
    expect(w('muzzleOffset')).toBe('vector3');
  });

  it('maps an in-file enum, distinguishing [Flags]', () => {
    expect(w('rarity')).toBe('enum');
    expect(w('element')).toBe('enumFlags');
  });

  it('resolves enum members with their serialized ordinals', () => {
    const rarity = schema.fields.find((f) => f.name === 'rarity')!;
    expect(rarity.enumMembers).toEqual([
      { name: 'Common', value: 0 },
      { name: 'Rare', value: 1 },
      { name: 'Epic', value: 2 },
      { name: 'Legendary', value: 3 },
    ]);
    const element = schema.fields.find((f) => f.name === 'element')!;
    expect(element.enumMembers).toEqual([
      { name: 'None', value: 0 },
      { name: 'Kinetic', value: 1 },
      { name: 'Ember', value: 2 },
      { name: 'Void', value: 4 },
    ]);
  });

  it('maps a UnityEngine.Object subclass to an object reference', () => {
    expect(w('icon')).toBe('objectRef');
    expect(w('projectile')).toBe('objectRef');
  });

  it('maps an in-file [Serializable] class to a nested value', () => {
    expect(w('inlineMod')).toBe('nested');
  });

  it('maps a structured Unity type we cannot edit to unknown', () => {
    expect(w('falloff')).toBe('unknown');
  });
});

describe('buildSoSchema — the never-over-claim invariant', () => {
  it('falls back to unknown for an unrecognised type', () => {
    const s = run(`public class A : ScriptableObject { [SerializeField] private Mystery m; }`);
    const field = s.fields.find((f) => f.name === 'm')!;
    expect(field.widget).toBe('unknown');
    expect(field.editable).toBe(false);
  });

  it('never marks an unknown, nested, array or [SerializeReference] field editable', () => {
    const schema = run(WEAPON);
    for (const f of schema.fields) {
      if (f.widget === 'unknown' || f.widget === 'nested' || f.isArray || f.serializeReference) {
        expect(f.editable).toBe(false);
      }
    }
  });

  it('marks a plain scalar editable', () => {
    const schema = run(WEAPON);
    expect(schema.fields.find((f) => f.name === 'damage')!.editable).toBe(true);
  });
});

describe('buildSoSchema — sequences', () => {
  const schema = run(WEAPON);
  const f = (n: string) => schema.fields.find((x) => x.name === n)!;

  it('detects List<T> and T[] alike', () => {
    expect(f('mods').isArray).toBe(true);
    expect(f('presets').isArray).toBe(true);
    expect(f('mods').elementType).toBe('WeaponMod');
    expect(f('presets').elementType).toBe('WeaponMod');
  });

  it('is not fooled by a non-sequence generic', () => {
    expect(elementTypeOf('Dictionary<string, int>')).toBeNull();
    expect(elementTypeOf('int')).toBeNull();
    expect(elementTypeOf('List<int>')).toBe('int');
    expect(elementTypeOf('int[]')).toBe('int');
  });
});

describe('buildSoSchema — header grouping', () => {
  const schema = run(WEAPON);

  it('starts a new group at each [Header]', () => {
    expect(schema.groups[0].header).toBe('Identity');
    expect(schema.groups[0].fields.map((f) => f.name)).toEqual([
      'displayName', 'icon', 'rarity',
    ]);
    expect(schema.groups[1].header).toBe('Ballistics');
  });

  it('puts fields declared before any header into a null-headed group', () => {
    const s = run('public class A : ScriptableObject { [SerializeField] private int a; [Header("H")] [SerializeField] private int b; }');
    expect(fieldGroups(s.fields).map((g) => g.header)).toEqual([null, 'H']);
  });
});

describe('buildSoSchema — base kinds', () => {
  it('recognises a MonoBehaviour', () => {
    expect(run('public class A : MonoBehaviour { }').baseKind).toBe('monoBehaviour');
  });

  it('reports an unresolved base rather than guessing', () => {
    const s = run('public class A : BaseDef { [SerializeField] private int a; }');
    expect(s.baseKind).toBe('unknown');
    expect(s.unresolvedBase).toBe('BaseDef');
    // Fields are STILL enumerated. The base check is syntactic and cannot see
    // `BaseDef : ScriptableObject` in another file, so gating fields on it
    // would leave the instance-count promotion with an empty form.
    expect(s.fields.map((f) => f.name)).toEqual(['a']);
  });

  it('ignores interfaces when naming the unresolved base', () => {
    const s = run('public class A : IThing, BaseDef { }');
    expect(s.unresolvedBase).toBe('BaseDef');
  });

  it('classBaseKind reads through a namespace qualifier', () => {
    const scan = scanCSharp('public class A : UnityEngine.ScriptableObject { }');
    expect(classBaseKind(scan.classes[0])).toBe('scriptableObject');
  });
});

describe('WIDGET_BY_TYPE drift guard', () => {
  it('declares a widget for every serializable Unity struct', () => {
    // A missing key is a type nobody made a decision about; `'unknown'` is a
    // decision. Adding to UNITY_SERIALIZABLE_STRUCTS must fail here until a
    // widget is chosen.
    for (const t of UNITY_SERIALIZABLE_STRUCTS) {
      expect(WIDGET_BY_TYPE[t]).toBeDefined();
    }
  });

  it('only uses names from the SoWidgetKind union', () => {
    const allowed = new Set([
      'int', 'float', 'bool', 'string', 'enum', 'enumFlags',
      'vector2', 'vector3', 'vector4', 'vector2Int', 'vector3Int',
      'color', 'rect', 'bounds', 'layerMask', 'objectRef', 'nested', 'unknown',
    ]);
    for (const [type, widget] of Object.entries(WIDGET_BY_TYPE)) {
      expect({ type, ok: allowed.has(widget) }).toEqual({ type, ok: true });
    }
  });
});

describe('widgetForType', () => {
  const scan = scanCSharp(WEAPON);

  it('resolves through a namespace qualifier and array suffix', () => {
    expect(widgetForType('UnityEngine.Vector3', scan)).toBe('vector3');
    expect(widgetForType('float', scan)).toBe('float');
  });

  it('prefers an in-file enum over an unknown name', () => {
    expect(widgetForType('Rarity', scan)).toBe('enum');
  });
});
