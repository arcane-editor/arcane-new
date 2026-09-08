import { describe, expect, it } from 'bun:test';
import { UNT_FIXES, untFixesFor, type Range1Based } from './unt-quick-fixes';

// What this protects: csharp-ls loads Microsoft.Unity.Analyzers' code fixes
// into its own process and never offers them — its code-action handler
// reflects over three Roslyn assemblies and ignores the project's analyzer
// references. So the editor supplies them, derived from the diagnostic's range
// alone. A quick fix that produces wrong code is worse than no quick fix, so
// every builder returns null on a shape it does not recognise, and the
// refusals are tested as carefully as the rewrites.
//
// **The ranges below are the ones the analyzer really emits**, captured by
// running csharp-ls 0.27 with Microsoft.Unity.Analyzers 1.27 over `FIXTURE`
// and printing each diagnostic's covered text:
//
//     UNT0016  covers "Invoke(\"Respawn\", 1f)"      ← the whole invocation
//     UNT0004  covers "fixedDeltaTime"               ← the member name alone
//     UNT0002  covers "tag == \"Player\""
//     UNT0003  covers "GetComponent(typeof(Rigidbody))"
//
// The first two are why this matters. An earlier version of these tests built
// the ranges by hand — `"Respawn"` and `Time.fixedDeltaTime` — and both
// builders passed their tests while being unreachable in the editor, because
// no diagnostic ever produces those ranges. Anything added here must be
// checked against the running analyzer, not against what looks natural.

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

const FIXTURE = [
  'using UnityEngine;',
  '',
  'public class Player : MonoBehaviour',
  '{',
  '    private void Update()',
  '    {',
  '        float step = Time.fixedDeltaTime;',
  '        if (tag == "Player") { }',
  '        if (gameObject.tag != "Enemy") { }',
  '        if ("Boss" == other.tag) { }',
  '        Invoke("Respawn", 1f);',
  '        StartCoroutine("Spawn");',
  '        var rb = GetComponent(typeof(Rigidbody));',
  '    }',
  '}',
  '',
].join('\n');

describe('UNT0002 — inefficient tag comparison', () => {
  it('rewrites a bare tag comparison to CompareTag', () => {
    const result = fix(FIXTURE, 'UNT0002', 'tag == "Player"');
    expect(result.edits[0].newText).toBe('CompareTag("Player")');
    expect(result.title).toBe('Use CompareTag("Player")');
  });

  it('keeps the receiver and negates for !=', () => {
    // The whole point of the rewrite is that it means the same thing.
    expect(fix(FIXTURE, 'UNT0002', 'gameObject.tag != "Enemy"').edits[0].newText).toBe(
      '!gameObject.CompareTag("Enemy")',
    );
    expect(fix(FIXTURE, 'UNT0002', 'tag == "Player"').edits[0].newText).not.toStartWith('!');
  });

  it('handles the literal on the left', () => {
    expect(fix(FIXTURE, 'UNT0002', '"Boss" == other.tag').edits[0].newText).toBe(
      'other.CompareTag("Boss")',
    );
  });

  it('declines a comparison against something that is not a literal', () => {
    const text = '        if (tag == other.tag) { }';
    expect(untFixesFor(text, [{ code: 'UNT0002', range: rangeOf(text, 'tag == other.tag') }]))
      .toEqual([]);
  });
});

describe('UNT0016 — unsafe method name in Invoke', () => {
  it('rewrites the literal inside the invocation the analyzer ranged', () => {
    // The range covers `Invoke("Respawn", 1f)` — arguments included.
    const result = fix(FIXTURE, 'UNT0016', 'Invoke("Respawn", 1f)');
    expect(result.edits[0].newText).toBe('Invoke(nameof(Respawn), 1f)');
    expect(result.title).toBe('Use nameof(Respawn)');
  });

  it('handles a coroutine started by name', () => {
    expect(fix(FIXTURE, 'UNT0016', 'StartCoroutine("Spawn")').edits[0].newText).toBe(
      'StartCoroutine(nameof(Spawn))',
    );
  });

  it('declines a literal that is not a valid identifier', () => {
    // `nameof("some method")` does not compile.
    const text = 'Invoke("some method", 1f);';
    expect(
      untFixesFor(text, [{ code: 'UNT0016', range: rangeOf(text, 'Invoke("some method", 1f)') }]),
    ).toEqual([]);
  });

  it('declines an invocation whose argument is already a nameof', () => {
    const text = 'Invoke(nameof(Respawn), 1f);';
    expect(
      untFixesFor(text, [{ code: 'UNT0016', range: rangeOf(text, 'Invoke(nameof(Respawn), 1f)') }]),
    ).toEqual([]);
  });
});

describe('UNT0003 — non-generic GetComponent', () => {
  it('rewrites typeof to a type argument', () => {
    expect(fix(FIXTURE, 'UNT0003', 'GetComponent(typeof(Rigidbody))').edits[0].newText).toBe(
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
  it('replaces only the member name the analyzer ranged', () => {
    // The range covers `fixedDeltaTime`, NOT `Time.fixedDeltaTime`. Replacing
    // it with the qualified name would produce `Time.Time.deltaTime`.
    const result = fix(FIXTURE, 'UNT0004', 'fixedDeltaTime');
    expect(result.edits[0].newText).toBe('deltaTime');
  });

  it('produces valid code when applied', () => {
    const range = rangeOf(FIXTURE, 'fixedDeltaTime');
    const result = fix(FIXTURE, 'UNT0004', 'fixedDeltaTime');
    const line = FIXTURE.split('\n')[range.startLineNumber - 1];
    const applied =
      line.slice(0, range.startColumn - 1) +
      result.edits[0].newText +
      line.slice(range.endColumn - 1);
    expect(applied.trim()).toBe('float step = Time.deltaTime;');
  });

  it('still handles a qualified range, in case the analyzer widens it', () => {
    const text = 'var step = Time.fixedDeltaTime;';
    expect(
      untFixesFor(text, [{ code: 'UNT0004', range: rangeOf(text, 'Time.fixedDeltaTime') }])[0]
        .edits[0].newText,
    ).toBe('Time.deltaTime');
  });
});

describe('routing', () => {
  it('offers nothing for a code it has no fix for', () => {
    // Most UNT rules have no safe range-only rewrite; a squiggle with no fix
    // is the correct outcome there.
    expect(untFixesFor(FIXTURE, [{ code: 'UNT0001', range: rangeOf(FIXTURE, 'Update') }])).toEqual(
      [],
    );
  });

  it('offers nothing for a marker with no code', () => {
    expect(untFixesFor(FIXTURE, [{ range: rangeOf(FIXTURE, 'Update') }])).toEqual([]);
  });

  it('survives a marker range outside the document', () => {
    // Markers can outlive the edit that shortened the file.
    expect(
      untFixesFor(FIXTURE, [
        {
          code: 'UNT0002',
          range: { startLineNumber: 900, startColumn: 1, endLineNumber: 900, endColumn: 9 },
        },
      ]),
    ).toEqual([]);
  });

  it('builds one fix per marker', () => {
    const found = untFixesFor(FIXTURE, [
      { code: 'UNT0002', range: rangeOf(FIXTURE, 'tag == "Player"') },
      { code: 'UNT0004', range: rangeOf(FIXTURE, 'fixedDeltaTime') },
    ]);
    expect(found).toHaveLength(2);
  });

  it('every registered code produces a fix for its real range', () => {
    // The guard against the failure this file was rewritten for: a builder
    // that is registered but unreachable. Each entry pairs a UNT code with the
    // text its diagnostic actually covers.
    const REAL_RANGES: Record<string, string> = {
      UNT0002: 'tag == "Player"',
      UNT0003: 'GetComponent(typeof(Rigidbody))',
      UNT0004: 'fixedDeltaTime',
      UNT0016: 'Invoke("Respawn", 1f)',
    };
    for (const code of Object.keys(UNT_FIXES)) {
      expect(code).toMatch(/^UNT\d{4}$/);
      const needle = REAL_RANGES[code];
      expect(needle, `no recorded analyzer range for ${code}`).toBeDefined();
      expect(fix(FIXTURE, code, needle), `${code} produced no fix`).toBeDefined();
    }
  });
});
