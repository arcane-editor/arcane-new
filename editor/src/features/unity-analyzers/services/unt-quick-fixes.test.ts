import { describe, expect, it } from 'bun:test';
import { UNT_FIXES, untFixesFor, type Range1Based } from './unt-quick-fixes';

// What this protects: csharp-ls loads Microsoft.Unity.Analyzers' code fixes
// into its own process and never offers them — its code-action handler
// reflects over three Roslyn assemblies and ignores the project's analyzer
// references. So the editor supplies them, and it does so from the
// diagnostic's range alone. A quick fix that produces wrong code is worse than
// no quick fix, so every builder here returns null on a shape it does not
// recognise, and these tests check the nulls as carefully as the rewrites.

/** The 1-based range covering `needle` in `text`. */
function rangeOf(text: string, needle: string): Range1Based {
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(`fixture does not contain ${JSON.stringify(needle)}`);
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  const column = index - (before.lastIndexOf('\n') + 1) + 1;
  return {
    startLineNumber: line,
    startColumn: column,
    endLineNumber: line,
    endColumn: column + needle.length,
  };
}

function fix(text: string, code: string, needle: string) {
  return untFixesFor(text, [{ code, range: rangeOf(text, needle) }])[0];
}

const FILE = [
  'using UnityEngine;',
  '',
  'public class Player : MonoBehaviour',
  '{',
  '    private void Update()',
  '    {',
  '        if (tag == "Player") { }',
  '        if (other.tag != "Enemy") { }',
  '        if ("Boss" == gameObject.tag) { }',
  '        Invoke("Respawn", 1f);',
  '        var rb = GetComponent(typeof(Rigidbody));',
  '        var step = Time.fixedDeltaTime;',
  '    }',
  '}',
  '',
].join('\n');

describe('UNT0002 — inefficient tag comparison', () => {
  it('rewrites a bare tag comparison to CompareTag', () => {
    const result = fix(FILE, 'UNT0002', 'tag == "Player"');
    expect(result.edits[0].newText).toBe('CompareTag("Player")');
    expect(result.title).toBe('Use CompareTag("Player")');
  });

  it('keeps the receiver', () => {
    expect(fix(FILE, 'UNT0002', 'other.tag != "Enemy"').edits[0].newText).toBe(
      '!other.CompareTag("Enemy")',
    );
  });

  it('negates for !=, rather than silently inverting the meaning', () => {
    // The whole point of the rewrite is that it is equivalent.
    expect(fix(FILE, 'UNT0002', 'other.tag != "Enemy"').edits[0].newText).toStartWith('!');
    expect(fix(FILE, 'UNT0002', 'tag == "Player"').edits[0].newText).not.toStartWith('!');
  });

  it('handles the literal on the left', () => {
    expect(fix(FILE, 'UNT0002', '"Boss" == gameObject.tag').edits[0].newText).toBe(
      'gameObject.CompareTag("Boss")',
    );
  });

  it('declines a comparison against something that is not a literal', () => {
    const text = '        if (tag == other.tag) { }';
    expect(untFixesFor(text, [{ code: 'UNT0002', range: rangeOf(text, 'tag == other.tag') }]))
      .toEqual([]);
  });
});

describe('UNT0016 — unsafe method name in Invoke', () => {
  it('rewrites the string literal to nameof', () => {
    expect(fix(FILE, 'UNT0016', '"Respawn"').edits[0].newText).toBe('nameof(Respawn)');
  });

  it('declines a literal that is not an identifier', () => {
    // `nameof("some method")` does not compile.
    const text = 'Invoke("some method", 1f);';
    expect(untFixesFor(text, [{ code: 'UNT0016', range: rangeOf(text, '"some method"') }]))
      .toEqual([]);
  });
});

describe('UNT0003 — non-generic GetComponent', () => {
  it('rewrites typeof to a type argument', () => {
    expect(fix(FILE, 'UNT0003', 'GetComponent(typeof(Rigidbody))').edits[0].newText).toBe(
      'GetComponent<Rigidbody>()',
    );
  });

  it('covers the InChildren and InParent variants', () => {
    for (const api of ['GetComponentInChildren', 'GetComponentInParent']) {
      const text = `var x = ${api}(typeof(Collider));`;
      const found = untFixesFor(text, [
        { code: 'UNT0003', range: rangeOf(text, `${api}(typeof(Collider))`) },
      ]);
      expect(found[0].edits[0].newText).toBe(`${api}<Collider>()`);
    }
  });
});

describe('UNT0004 — fixed delta time in Update', () => {
  it('swaps to the per-frame delta', () => {
    expect(fix(FILE, 'UNT0004', 'Time.fixedDeltaTime').edits[0].newText).toBe('Time.deltaTime');
  });
});

describe('routing', () => {
  it('offers nothing for a code it has no fix for', () => {
    // Most UNT rules have no safe range-only rewrite; a squiggle with no fix
    // is the correct outcome there.
    expect(untFixesFor(FILE, [{ code: 'UNT0001', range: rangeOf(FILE, 'Update') }])).toEqual([]);
  });

  it('offers nothing for a marker with no code', () => {
    expect(untFixesFor(FILE, [{ range: rangeOf(FILE, 'Update') }])).toEqual([]);
  });

  it('survives a marker range outside the document', () => {
    // Markers can outlive the edit that shortened the file.
    expect(
      untFixesFor(FILE, [
        {
          code: 'UNT0002',
          range: { startLineNumber: 900, startColumn: 1, endLineNumber: 900, endColumn: 9 },
        },
      ]),
    ).toEqual([]);
  });

  it('builds one fix per marker', () => {
    const found = untFixesFor(FILE, [
      { code: 'UNT0002', range: rangeOf(FILE, 'tag == "Player"') },
      { code: 'UNT0004', range: rangeOf(FILE, 'Time.fixedDeltaTime') },
    ]);
    expect(found).toHaveLength(2);
  });

  it('only claims UNT codes it can actually fix', () => {
    for (const code of Object.keys(UNT_FIXES)) {
      expect(code).toMatch(/^UNT\d{4}$/);
    }
  });
});
