import { describe, it, expect } from 'bun:test';
import { scanCSharp } from './csharp-scan';
import {
  isSerializedField,
  serializedFieldAtOffset,
  serializedFieldByName,
} from './serialized-fields';

// Characterization tests for the serialized-field predicate. This is the single
// source of truth for "will Unity serialize this field", relied on by the
// serialization diagnostics, the [FormerlySerializedAs] rename hook, and the
// ScriptableObject schema. It had no tests.

/** Scan a class body and answer whether `name` is serialized. */
function serialized(body: string, name: string, base = 'MonoBehaviour'): boolean {
  const code = `using System;\nusing UnityEngine;\npublic class T : ${base} {\n${body}\n}`;
  const scan = scanCSharp(code);
  const field = scan.fields.find((f) => f.name === name);
  if (!field) throw new Error(`field ${name} not scanned from: ${body}`);
  return isSerializedField(scan, field);
}

describe('isSerializedField — visibility', () => {
  it('serializes a public instance field', () => {
    expect(serialized('public int a;', 'a')).toBe(true);
  });

  it('does not serialize a bare private field', () => {
    expect(serialized('private int a;', 'a')).toBe(false);
  });

  it('serializes a private field marked [SerializeField]', () => {
    expect(serialized('[SerializeField] private int a;', 'a')).toBe(true);
  });

  it('serializes a protected field marked [SerializeField]', () => {
    expect(serialized('[SerializeField] protected int a;', 'a')).toBe(true);
  });

  it('does not serialize a field with no modifier at all', () => {
    expect(serialized('int a;', 'a')).toBe(false);
  });
});

describe('isSerializedField — opt-outs', () => {
  it('honours [NonSerialized] over public', () => {
    expect(serialized('[NonSerialized] public int a;', 'a')).toBe(false);
  });

  it('honours [NonSerialized] over [SerializeField]', () => {
    expect(serialized('[NonSerialized] [SerializeField] private int a;', 'a')).toBe(false);
  });

  it('never serializes static, const or readonly', () => {
    expect(serialized('public static int a;', 'a')).toBe(false);
    expect(serialized('public const int a = 1;', 'a')).toBe(false);
    expect(serialized('public readonly int a;', 'a')).toBe(false);
  });

  it('does not serialize a static field even with [SerializeField]', () => {
    expect(serialized('[SerializeField] private static int a;', 'a')).toBe(false);
  });
});

describe('isSerializedField — owning class', () => {
  it('serializes in a ScriptableObject', () => {
    expect(serialized('public int a;', 'a', 'ScriptableObject')).toBe(true);
  });

  it('does not serialize in a plain class', () => {
    expect(serialized('public int a;', 'a', 'object')).toBe(false);
  });

  it('does not serialize in a class with no base list', () => {
    const scan = scanCSharp('public class T {\npublic int a;\n}');
    const field = scan.fields.find((f) => f.name === 'a')!;
    expect(isSerializedField(scan, field)).toBe(false);
  });

  it('resolves the base type through a namespace qualifier', () => {
    expect(serialized('public int a;', 'a', 'UnityEngine.MonoBehaviour')).toBe(true);
  });
});

describe('serializedFieldAtOffset', () => {
  const src = 'using UnityEngine;\npublic class T : MonoBehaviour {\n  [SerializeField] private int damage;\n  private int hidden;\n}';
  const scan = scanCSharp(src);
  const damageOffset = src.indexOf('damage');

  it('matches anywhere across the identifier, inclusive of both ends', () => {
    for (let i = 0; i <= 'damage'.length; i++) {
      expect(serializedFieldAtOffset(scan, damageOffset + i)?.name).toBe('damage');
    }
  });

  it('returns null just before the identifier', () => {
    expect(serializedFieldAtOffset(scan, damageOffset - 1)).toBeNull();
  });

  it('returns null for a field that is not serialized', () => {
    expect(serializedFieldAtOffset(scan, src.indexOf('hidden'))).toBeNull();
  });
});

describe('serializedFieldByName', () => {
  const scan = scanCSharp(
    'using UnityEngine;\npublic class T : MonoBehaviour {\n  [SerializeField] private int damage;\n  private int hidden;\n}',
  );

  it('finds a serialized field', () => {
    expect(serializedFieldByName(scan, 'damage')?.name).toBe('damage');
  });

  it('returns null for a non-serialized field', () => {
    expect(serializedFieldByName(scan, 'hidden')).toBeNull();
  });

  it('returns null for an unknown name', () => {
    expect(serializedFieldByName(scan, 'nope')).toBeNull();
  });
});
