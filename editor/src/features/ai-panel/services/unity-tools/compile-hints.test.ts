import { describe, it, expect } from 'bun:test';
import {
  buildCompileHints,
  extractMissingMember,
  extractMissingType,
  extractBadOverload,
  type HintLookup,
} from './compile-hints';
import type { CompilerMessage } from '../../../../types/unity';
import type { ApiSignature, ApiSearchHit } from './api-client';

function err(message: string, file = 'Assets/Scripts/Foo.cs'): CompilerMessage {
  return { file, line: 12, column: 5, message, type: 'Error' };
}

function fakeClient(overrides: Partial<HintLookup> = {}): HintLookup {
  return {
    lookup: async () => ({ ok: true, data: [] }),
    search: async () => ({ ok: true, data: [] }),
    ...overrides,
  };
}

describe('extraction helpers', () => {
  it('extractMissingMember parses CS1061', () => {
    expect(
      extractMissingMember("error CS1061: 'Rigidbody' does not contain a definition for 'Fly'"),
    ).toEqual({ type: 'Rigidbody', member: 'Fly' });
  });

  it('extractMissingMember parses CS0117', () => {
    expect(
      extractMissingMember("error CS0117: 'Transform' does not contain a definition for 'Teleport'"),
    ).toEqual({ type: 'Transform', member: 'Teleport' });
  });

  it('extractMissingMember returns null for unrelated codes', () => {
    expect(extractMissingMember("error CS0246: The type or namespace name 'Foo' could not be found")).toBeNull();
  });

  it('extractMissingType parses CS0246', () => {
    expect(
      extractMissingType(
        "error CS0246: The type or namespace name 'PhotonView' could not be found (are you missing a using directive or an assembly reference?)",
      ),
    ).toBe('PhotonView');
  });

  it('extractBadOverload parses CS1501', () => {
    expect(extractBadOverload("error CS1501: No overload for method 'AddForce' takes 3 arguments")).toEqual({
      method: 'AddForce',
    });
  });
});

describe('buildCompileHints — CS1061/CS0117 member hints (existing behavior)', () => {
  it('CS1061: inlines real members of the type, byte-identical to the pre-extraction format', async () => {
    const errors = [err("error CS1061: 'Rigidbody' does not contain a definition for 'Fly'")];
    const sigs: ApiSignature[] = [
      { type: 'Rigidbody', member: 'AddForce', kind: 'method', signature: 'void AddForce(Vector3 force)' },
      { type: 'Rigidbody', member: 'velocity', kind: 'property', signature: 'Vector3 velocity' },
    ];
    const client = fakeClient({
      lookup: async (type, member) => {
        expect(type).toBe('Rigidbody');
        expect(member).toBeUndefined();
        return { ok: true, data: sigs };
      },
    });
    const text = await buildCompileHints(errors, client);
    expect(text).toBe('\n[Unity API] Real members of Rigidbody: AddForce, velocity');
  });

  it('CS0117: same code path as CS1061', async () => {
    const errors = [err("error CS0117: 'Transform' does not contain a definition for 'Teleport'")];
    const sigs: ApiSignature[] = [
      { type: 'Transform', member: 'position', kind: 'property', signature: 'Vector3 position' },
    ];
    const client = fakeClient({ lookup: async () => ({ ok: true, data: sigs }) });
    const text = await buildCompileHints(errors, client);
    expect(text).toBe('\n[Unity API] Real members of Transform: position');
  });

  it('dedupes member names and caps the list at 32', async () => {
    const errors = [err("error CS1061: 'Foo' does not contain a definition for 'Bar'")];
    const many = Array.from({ length: 40 }, (_, i) => `M${i}`);
    const sigs: ApiSignature[] = [...many, ...many].map((member) => ({
      type: 'Foo',
      member,
      kind: 'method',
      signature: `void ${member}()`,
    }));
    const client = fakeClient({ lookup: async () => ({ ok: true, data: sigs }) });
    const text = await buildCompileHints(errors, client);
    const listed = text.replace('\n[Unity API] Real members of Foo: ', '').split(', ');
    expect(listed).toHaveLength(32);
    expect(listed).toEqual(many.slice(0, 32));
  });

  it('caps respected: 4 distinct types in errors → only 3 hinted', async () => {
    const errors = [
      err("error CS1061: 'A' does not contain a definition for 'x'"),
      err("error CS1061: 'B' does not contain a definition for 'x'"),
      err("error CS1061: 'C' does not contain a definition for 'x'"),
      err("error CS1061: 'D' does not contain a definition for 'x'"),
    ];
    const lookedUp: string[] = [];
    const client = fakeClient({
      lookup: async (type) => {
        lookedUp.push(type);
        return { ok: true, data: [{ type, member: 'x', kind: 'method', signature: 'void x()' }] };
      },
    });
    const text = await buildCompileHints(errors, client);
    expect(lookedUp).toEqual(['A', 'B', 'C']);
    expect(text).not.toContain('D');
    expect(text.split('\n')).toHaveLength(4); // '' + 3 "Real members of" lines folded under one [Unity API] line
  });

  it('ok:false from the client → silent skip, no hint text at all', async () => {
    const errors = [err("error CS1061: 'Rigidbody' does not contain a definition for 'Fly'")];
    const client = fakeClient({ lookup: async () => ({ ok: false, reason: 'signed-out' }) });
    const text = await buildCompileHints(errors, client);
    expect(text).toBe('');
  });
});

describe('buildCompileHints — CS0246 missing type', () => {
  it('known type → namespace + using hint', async () => {
    const errors = [
      err("error CS0246: The type or namespace name 'Rigidbody2D' could not be found (are you missing a using directive or an assembly reference?)"),
    ];
    const sigs: ApiSignature[] = [
      {
        type: 'Rigidbody2D',
        member: 'AddForce',
        kind: 'method',
        signature: 'void AddForce(Vector2 force)',
        namespace: 'UnityEngine',
        docUrl: 'https://docs.unity3d.com/ScriptReference/Rigidbody2D.html',
      },
    ];
    const client = fakeClient({
      lookup: async (type) => {
        expect(type).toBe('Rigidbody2D');
        return { ok: true, data: sigs };
      },
      search: async () => {
        throw new Error('should not fall back to search when lookup found the type');
      },
    });
    const text = await buildCompileHints(errors, client);
    expect(text).toBe(
      '\n[Unity API] Rigidbody2D found in namespace UnityEngine — add `using UnityEngine;` ' +
        '(https://docs.unity3d.com/ScriptReference/Rigidbody2D.html)',
    );
  });

  it('unknown type → did-you-mean from ONE fuzzy search fallback', async () => {
    const errors = [
      err("error CS0246: The type or namespace name 'Rigidboyd' could not be found (are you missing a using directive or an assembly reference?)"),
    ];
    let searchCalls = 0;
    const hits: ApiSearchHit[] = [{ breadcrumb: 'Rigidbody', score: 0.87 }];
    const client = fakeClient({
      lookup: async () => ({ ok: true, data: [] }),
      search: async (query) => {
        searchCalls++;
        expect(query).toBe('Rigidboyd');
        return { ok: true, data: hits };
      },
    });
    const text = await buildCompileHints(errors, client);
    expect(searchCalls).toBe(1);
    expect(text).toBe('\n[Unity API] Rigidboyd not found — did you mean "Rigidbody"?');
  });

  it('failed lookup + failed search → no hint', async () => {
    const errors = [
      err("error CS0246: The type or namespace name 'Xyz' could not be found (are you missing a using directive or an assembly reference?)"),
    ];
    const client = fakeClient({
      lookup: async () => ({ ok: false, reason: 'no-unity-version' }),
      search: async () => ({ ok: false, reason: 'no-unity-version' }),
    });
    const text = await buildCompileHints(errors, client);
    expect(text).toBe('');
  });

  it('unsane (low-score) search hit → no did-you-mean hint', async () => {
    const errors = [
      err("error CS0246: The type or namespace name 'Xyz' could not be found (are you missing a using directive or an assembly reference?)"),
    ];
    const client = fakeClient({
      lookup: async () => ({ ok: true, data: [] }),
      search: async () => ({ ok: true, data: [{ breadcrumb: 'SomethingUnrelated', score: 0.05 }] }),
    });
    const text = await buildCompileHints(errors, client);
    expect(text).toBe('');
  });
});

describe('buildCompileHints — CS1501 wrong overload arity', () => {
  it('same-batch type identification → full overload list inlined', async () => {
    const errors = [
      err("error CS1061: 'Rigidbody' does not contain a definition for 'Fly'"),
      err("error CS1501: No overload for method 'AddForce' takes 3 arguments"),
    ];
    const memberSigs: ApiSignature[] = [
      { type: 'Rigidbody', member: 'velocity', kind: 'property', signature: 'Vector3 velocity' },
    ];
    const overloadSigs: ApiSignature[] = [
      {
        type: 'Rigidbody',
        member: 'AddForce',
        kind: 'method',
        signature: 'void AddForce(Vector3 force)',
        overloads: ['void AddForce(Vector3 force)', 'void AddForce(Vector3 force, ForceMode mode)'],
      },
    ];
    const client = fakeClient({
      lookup: async (type, member) => {
        if (member === undefined) return { ok: true, data: memberSigs };
        expect(type).toBe('Rigidbody');
        expect(member).toBe('AddForce');
        return { ok: true, data: overloadSigs };
      },
    });
    const text = await buildCompileHints(errors, client);
    expect(text).toContain(
      'Rigidbody.AddForce overloads: void AddForce(Vector3 force) | void AddForce(Vector3 force, ForceMode mode)',
    );
  });

  it('qualified method name alone identifies the receiver (path b), even with no other batch errors', async () => {
    const errors = [err("error CS1501: No overload for method 'Rigidbody.AddForce' takes 3 arguments")];
    const overloadSigs: ApiSignature[] = [
      { type: 'Rigidbody', member: 'AddForce', kind: 'method', signature: 'void AddForce(Vector3 force)' },
    ];
    const client = fakeClient({
      lookup: async (type, member) => {
        expect(type).toBe('Rigidbody');
        expect(member).toBe('AddForce');
        return { ok: true, data: overloadSigs };
      },
    });
    const text = await buildCompileHints(errors, client);
    expect(text).toBe('\n[Unity API] Rigidbody.AddForce overloads: void AddForce(Vector3 force)');
  });

  it('without an identifiable receiver → nothing (no guessing)', async () => {
    const errors = [err("error CS1501: No overload for method 'AddForce' takes 3 arguments")];
    const client = fakeClient({
      lookup: async () => {
        throw new Error('should never call lookup with no identifiable receiver type');
      },
    });
    const text = await buildCompileHints(errors, client);
    expect(text).toBe('');
  });

  it('ambiguous batch (2+ candidate types) → nothing (no guessing)', async () => {
    const errors = [
      err("error CS1061: 'A' does not contain a definition for 'x'"),
      err("error CS1061: 'B' does not contain a definition for 'y'"),
      err("error CS1501: No overload for method 'AddForce' takes 3 arguments"),
    ];
    let overloadLookupCalled = false;
    const client = fakeClient({
      lookup: async (_type, member) => {
        if (member === 'AddForce') overloadLookupCalled = true;
        return { ok: true, data: [] };
      },
    });
    await buildCompileHints(errors, client);
    expect(overloadLookupCalled).toBe(false);
  });

  it('caps overloads listed at 8', async () => {
    const overloads = Array.from({ length: 12 }, (_, i) => `void AddForce(${i} args)`);
    const errors = [err("error CS1501: No overload for method 'Rigidbody.AddForce' takes 12 arguments")];
    const client = fakeClient({
      lookup: async () => ({
        ok: true,
        data: [{ type: 'Rigidbody', member: 'AddForce', kind: 'method', signature: overloads[0]!, overloads }],
      }),
    });
    const text = await buildCompileHints(errors, client);
    const listed = text
      .replace('\n[Unity API] Rigidbody.AddForce overloads: ', '')
      .split(' | ');
    expect(listed).toHaveLength(8);
  });
});
