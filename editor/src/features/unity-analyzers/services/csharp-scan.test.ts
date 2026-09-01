import { describe, it, expect } from 'bun:test';
import {
  scanCSharp,
  offsetInSpan,
  offsetToLineCol,
  lineColToOffset,
  classContaining,
  methodContaining,
} from './csharp-scan';

// Characterization tests for the shared C# scanner.
//
// This module underpins every Unity analyzer rule and had no tests at all. The
// suite below pins EXISTING behaviour so that later additions (attribute
// arguments, enum declarations) are provably additive — if one of these breaks,
// a consumer breaks with it.

const SAMPLE = `using System;
using UnityEngine;
using UnityEngine.Serialization;

namespace Game.Combat
{
    /// <summary>A weapon. // not a comment marker, it's inside a doc comment</summary>
    [CreateAssetMenu(fileName = "New Weapon", menuName = "Game/Weapon")]
    public class WeaponDef : ScriptableObject, IEquatable<WeaponDef>
    {
        [Header("Identity")]
        [SerializeField] private string displayName = "Sword";

        [SerializeField]
        [Tooltip("Damage per shot, before armour")]
        [Range(0f, 50f)]
        private float damage = 12f;

        public int magazineSize = 30;

        [NonSerialized] public float runtimeHeat;

        private static readonly string Prefix = "wpn_";
        public const int MaxTier = 5;

        [FormerlySerializedAs("dmg")]
        [UnityEngine.SerializeField]
        private float spread;

        public float Damage => damage;

        private void Awake()
        {
            var s = "a string with class Foo : MonoBehaviour { } inside";
            // a line comment mentioning damage = 999;
            Debug.Log(s);
        }

        public bool Equals(WeaponDef other) => other != null;
    }
}
`;

describe('scanCSharp — resilience', () => {
  it('never throws on truncated input', () => {
    for (let cut = 0; cut <= SAMPLE.length; cut += 25) {
      const partial = SAMPLE.slice(0, cut);
      expect(() => scanCSharp(partial)).not.toThrow();
    }
  });

  it('never throws on malformed input', () => {
    const junk = [
      '',
      '{',
      '}}}}',
      'class {',
      'public class A : B {',
      'string s = "unterminated',
      '/* unterminated block comment',
      "char c = '",
      'class A { class B { class C {',
      '[[[[[[',
      '@"verbatim \\ ',
      '$"interp {x}',
    ];
    for (const j of junk) {
      expect(() => scanCSharp(j)).not.toThrow();
    }
  });
});

describe('scanCSharp — the code view preserves offsets', () => {
  const scan = scanCSharp(SAMPLE);

  it('has the same length as the original text', () => {
    expect(scan.code.length).toBe(scan.text.length);
  });

  it('keeps every newline at the same offset', () => {
    const nl = (s: string) => {
      const out: number[] = [];
      for (let i = 0; i < s.length; i++) if (s[i] === '\n') out.push(i);
      return out;
    };
    expect(nl(scan.code)).toEqual(nl(scan.text));
  });

  it('blanks string contents so identifiers inside literals do not match', () => {
    // The literal in Awake() contains `class Foo : MonoBehaviour`. If blanking
    // failed, CLASS_RE would pick up a bogus `Foo` class.
    expect(scan.text).toContain('class Foo : MonoBehaviour');
    expect(scan.code).not.toContain('class Foo');
    expect(scan.classes.map((c) => c.name)).not.toContain('Foo');
  });

  it('blanks line comments', () => {
    expect(scan.text).toContain('a line comment mentioning damage = 999;');
    expect(scan.code).not.toContain('a line comment mentioning');
  });

  it('leaves the original text untouched', () => {
    expect(scan.text).toBe(SAMPLE);
  });
});

describe('scanCSharp — offset/line mapping', () => {
  const scan = scanCSharp(SAMPLE);

  it('round-trips offset -> line/col -> offset', () => {
    for (let i = 0; i < SAMPLE.length; i += 7) {
      const { line, col } = offsetToLineCol(scan.lineStarts, i);
      expect(lineColToOffset(scan.lineStarts, line, col)).toBe(i);
    }
  });
});

describe('scanCSharp — structure', () => {
  const scan = scanCSharp(SAMPLE);

  it('finds the usings', () => {
    expect(scan.usings.map((u) => u.name)).toEqual([
      'System',
      'UnityEngine',
      'UnityEngine.Serialization',
    ]);
  });

  it('finds the class and its base list', () => {
    const cls = scan.classes.find((c) => c.name === 'WeaponDef');
    expect(cls).toBeDefined();
    expect(cls!.baseTypes).toContain('ScriptableObject');
    expect(cls!.bodySpan).not.toBeNull();
  });

  it('strips generic args from base types', () => {
    const cls = scan.classes.find((c) => c.name === 'WeaponDef')!;
    // `IEquatable<WeaponDef>` keeps only the leading identifier.
    expect(cls.baseTypes).toContain('IEquatable');
  });

  it('finds the serialized fields', () => {
    const names = scan.fields.map((f) => f.name);
    expect(names).toContain('displayName');
    expect(names).toContain('damage');
    expect(names).toContain('magazineSize');
    expect(names).toContain('spread');
  });

  it('records modifiers', () => {
    const prefix = scan.fields.find((f) => f.name === 'Prefix')!;
    expect(prefix.modifiers).toContain('static');
    expect(prefix.modifiers).toContain('readonly');
    const maxTier = scan.fields.find((f) => f.name === 'MaxTier')!;
    expect(maxTier.modifiers).toContain('const');
  });

  it('finds methods and their bodies', () => {
    const awake = scan.methods.find((m) => m.name === 'Awake');
    expect(awake).toBeDefined();
    expect(awake!.bodySpan).not.toBeNull();
  });

  it('picks the innermost containing class and method', () => {
    const awake = scan.methods.find((m) => m.name === 'Awake')!;
    const inside = awake.bodySpan!.start + 5;
    expect(classContaining(scan, inside)?.name).toBe('WeaponDef');
    expect(methodContaining(scan, inside)?.name).toBe('Awake');
  });
});

describe('scanCSharp — attributes (current, names-only contract)', () => {
  const scan = scanCSharp(SAMPLE);
  const field = (n: string) => scan.fields.find((f) => f.name === n)!;

  it('collects attribute names only, without arguments', () => {
    expect(field('damage').attributes).toEqual([
      'SerializeField',
      'Tooltip',
      'Range',
    ]);
  });

  it('normalises a namespace-qualified attribute to its short name', () => {
    expect(field('spread').attributes).toContain('SerializeField');
    expect(field('spread').attributes).not.toContain('UnityEngine.SerializeField');
  });

  it('collects several attribute blocks stacked above one field, in source order', () => {
    expect(field('spread').attributes).toEqual([
      'FormerlySerializedAs',
      'SerializeField',
    ]);
  });

  it('splits multiple attributes declared in one block, in source order', () => {
    // Regression: the collector used to push into a shared list and reverse it
    // at the end to fix BLOCK order, which also reversed the order WITHIN a
    // block — `[A, B]` came back as `["B", "A"]`. Every consumer uses
    // `.includes()`, so it went unnoticed.
    const s = scanCSharp('class A : MonoBehaviour { [A, B(1)] public int x; }');
    expect(s.fields[0].attributes).toEqual(['A', 'B']);
  });

  it('sees [NonSerialized]', () => {
    expect(field('runtimeHeat').attributes).toContain('NonSerialized');
  });

  it('starts declSpan at the first attribute, not the modifier', () => {
    const f = field('damage');
    expect(scan.text.slice(f.declSpan.start, f.declSpan.end)).toContain('[SerializeField]');
  });
});

describe('scanCSharp — field-match rejections', () => {
  it('does not treat a parenthesised expression as a field type', () => {
    const s = scanCSharp('class A : MonoBehaviour { void M() { var v = Foo(1); } }');
    expect(s.fields.map((f) => f.name)).not.toContain('v');
  });

  it('does not treat control-flow keywords as field declarations', () => {
    const s = scanCSharp('class A : MonoBehaviour { void M() { return; } }');
    expect(s.fields).toHaveLength(0);
  });

  it('finds no fields in an empty document', () => {
    expect(scanCSharp('').fields).toHaveLength(0);
  });
});

describe('offsetInSpan', () => {
  it('is inclusive of start and exclusive of end', () => {
    const span = { start: 3, end: 6 };
    expect(offsetInSpan(span, 2)).toBe(false);
    expect(offsetInSpan(span, 3)).toBe(true);
    expect(offsetInSpan(span, 5)).toBe(true);
    expect(offsetInSpan(span, 6)).toBe(false);
  });
});

// ── Extension: attribute arguments ──────────────────────────────────────────

describe('scanCSharp — attribute arguments', () => {
  const scan = scanCSharp(SAMPLE);
  const use = (fieldName: string, attr: string) =>
    scan.fields.find((f) => f.name === fieldName)!.attributeUses.find((a) => a.name === attr)!;

  it('reads string arguments from the real text, not the blanked code view', () => {
    // THE regression this file exists for. `collectLeadingAttributes` walks the
    // blanked `code`, where string contents are spaces — reading args from it
    // yields "                " instead of the tooltip.
    const tooltip = use('damage', 'Tooltip');
    expect(tooltip.args).toHaveLength(1);
    expect(tooltip.args[0].text).toBe('Damage per shot, before armour');
    expect(tooltip.args[0].text).not.toMatch(/^\s*$/);
  });

  it('does not split an argument list on a comma inside a string literal', () => {
    // The tooltip above contains ", before armour" — one arg, not two.
    expect(use('damage', 'Tooltip').args).toHaveLength(1);
  });

  it('decodes numeric arguments, ignoring C# suffixes', () => {
    const range = use('damage', 'Range');
    expect(range.args.map((a) => a.number)).toEqual([0, 50]);
  });

  it('captures named arguments on a class attribute', () => {
    const cls = scan.classes.find((c) => c.name === 'WeaponDef')!;
    const menu = cls.attributeUses.find((a) => a.name === 'CreateAssetMenu')!;
    expect(menu.args.map((a) => a.name)).toEqual(['fileName', 'menuName']);
    expect(menu.args.map((a) => a.text)).toEqual(['New Weapon', 'Game/Weapon']);
  });

  it('collects class attributes despite the modifiers between them and the keyword', () => {
    const cls = scan.classes.find((c) => c.name === 'WeaponDef')!;
    expect(cls.attributes).toContain('CreateAssetMenu');
    expect(cls.isStruct).toBe(false);
  });

  it('records the FormerlySerializedAs argument', () => {
    const fsa = use('spread', 'FormerlySerializedAs');
    expect(fsa.args[0].text).toBe('dmg');
  });

  it('keeps attributeUses aligned with the names-only list', () => {
    for (const f of scan.fields) {
      expect(f.attributeUses.map((a) => a.name)).toEqual(f.attributes);
    }
  });

  it('yields no args for a bare attribute', () => {
    expect(use('damage', 'SerializeField').args).toHaveLength(0);
  });
});

// ── Extension: enums ────────────────────────────────────────────────────────

const ENUM_SAMPLE = `using System;
using UnityEngine;

public enum Rarity { Common, Rare, Epic, Legendary }

public enum Tier : byte { Low = 3, Mid, High = 0x10 }

[Flags]
public enum Element
{
    None = 0,
    Kinetic = 1 << 0,
    Ember = 1 << 1,
    Void = 1 << 2,
    All = 7,
}

public class Weapon : ScriptableObject
{
    [SerializeField] private Rarity rarity;
    [SerializeField] private Element element;
}
`;

describe('scanCSharp — enum declarations', () => {
  const scan = scanCSharp(ENUM_SAMPLE);
  const e = (n: string) => scan.enums.find((x) => x.name === n)!;

  it('finds every enum', () => {
    expect(scan.enums.map((x) => x.name)).toEqual(['Rarity', 'Tier', 'Element']);
  });

  it('assigns implicit ordinals from zero', () => {
    expect(e('Rarity').members.map((m) => [m.name, m.value])).toEqual([
      ['Common', 0], ['Rare', 1], ['Epic', 2], ['Legendary', 3],
    ]);
  });

  it('continues from an explicit value and understands hex', () => {
    expect(e('Tier').members.map((m) => [m.name, m.value])).toEqual([
      ['Low', 3], ['Mid', 4], ['High', 16],
    ]);
    expect(e('Tier').underlyingType).toBe('byte');
  });

  it('resolves shift expressions, which [Flags] enums are written with', () => {
    expect(e('Element').members.map((m) => [m.name, m.value])).toEqual([
      ['None', 0], ['Kinetic', 1], ['Ember', 2], ['Void', 4], ['All', 7],
    ]);
  });

  it('detects [Flags]', () => {
    expect(e('Element').isFlags).toBe(true);
    expect(e('Rarity').isFlags).toBe(false);
  });

  it('does not mistake an enum for a class', () => {
    expect(scan.classes.map((c) => c.name)).toEqual(['Weapon']);
  });

  it('does not report enum members as fields', () => {
    const names = scan.fields.map((f) => f.name);
    expect(names).toEqual(['rarity', 'element']);
  });

  it('finds an enum nested inside a class body', () => {
    const s = scanCSharp('public class A : ScriptableObject { public enum Mode { X, Y } }');
    expect(s.enums.map((x) => x.name)).toEqual(['Mode']);
    expect(s.enums[0].members.map((m) => m.name)).toEqual(['X', 'Y']);
  });

  it('never throws on a malformed enum', () => {
    expect(() => scanCSharp('enum Broken { A = , B')).not.toThrow();
    expect(() => scanCSharp('enum {')).not.toThrow();
  });
});

describe('scanCSharp — enum bodies do not swallow the fields below them', () => {
  // Regression. FIELD_RE's trailing `(?:=\s*[^;]*)?;` could start at an `=`
  // inside an enum body and run to the next `;` — the first real field under
  // the enum — consuming it and reporting a bogus field in its place. A
  // ScriptableObject with an enum-typed serialized field is exactly this shape.
  const SRC = `public enum Tier : byte { Low = 3, Mid, High = 0x10 }

public class Weapon : ScriptableObject
{
    [SerializeField] private Tier tier;
    [SerializeField] private int damage;
}
`;
  const scan = scanCSharp(SRC);

  it('still finds the field declared after the enum', () => {
    expect(scan.fields.map((f) => f.name)).toEqual(['tier', 'damage']);
  });

  it('reports no field named after an enum member', () => {
    expect(scan.fields.map((f) => f.name)).not.toContain('High');
  });

  it('keeps the enum itself intact', () => {
    expect(scan.enums[0].members.map((m) => m.name)).toEqual(['Low', 'Mid', 'High']);
  });
});
