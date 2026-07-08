import { describe, it, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChecks } from './checks';

describe('runChecks', () => {
  it('evaluates file and answer checks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-checks-'));
    try {
      await mkdir(join(dir, 'Assets/Scripts'), { recursive: true });
      await writeFile(
        join(dir, 'Assets/Scripts/A.cs'),
        'using UnityEngine;\npublic class A : MonoBehaviour { void Update() { } }',
      );
      const results = await runChecks(
        [
          { type: 'file_exists', path: 'Assets/Scripts/A.cs' },
          { type: 'file_contains', path: 'Assets/Scripts/A.cs', pattern: 'MonoBehaviour' },
          { type: 'file_not_contains', path: 'Assets/Scripts/A.cs', pattern: 'InputSystem' },
          { type: 'analyzer_clean', glob: 'Assets/Scripts/*.cs' },
          { type: 'answer_matches', pattern: '_BaseColor' },
          { type: 'answer_not_matches', pattern: 'GetKey' },
        ],
        { workDir: dir, finalAnswer: 'Use material.SetColor("_BaseColor", c) in URP.' },
      );
      expect(results.map((r) => r.pass)).toEqual([true, true, true, true, true, true]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // NOTE: the brief's original seed for this test was `void update()` (lower-case),
  // expecting an error-severity finding from the near-miss-messages rule. Two
  // problems surfaced during implementation (see checks.ts's module doc for the
  // full investigation):
  //  1. near-miss-messages defaults to `warning`, not `error` — the *only*
  //     rule that defaults to `error` is `editor-api-in-runtime`
  //     (fixtures/analyzers/CorrectnessRules.cs documents this explicitly).
  //  2. near-miss-messages' own module isn't Bun-safe anyway (it imports the
  //     `../../csharp` barrel, which drags in Monaco transitively).
  // So the seed below exercises the real `error`-severity case instead: a
  // `using UnityEditor;` directive leaking into a runtime script.
  it('fails analyzer_clean on error-severity findings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-checks-'));
    try {
      await mkdir(join(dir, 'Assets'), { recursive: true });
      await writeFile(
        join(dir, 'Assets/Bad.cs'),
        'using UnityEngine;\nusing UnityEditor;\npublic class Bad : MonoBehaviour { void Start() { } }',
      );
      const results = await runChecks([{ type: 'analyzer_clean', glob: 'Assets/*.cs' }], {
        workDir: dir,
        finalAnswer: '',
      });
      expect(results[0].pass).toBe(false);
      expect(results[0].detail.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not fail analyzer_clean on warning-severity findings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-checks-'));
    try {
      await mkdir(join(dir, 'Assets'), { recursive: true });
      // Black-box contract test: analyzer_clean only ever gates on
      // `error`-severity findings. GetComponent-in-Update would trigger a
      // `warning`-severity finding under the full analyzer engine, but
      // checks.ts only runs the ported `editor-api-in-runtime` (`error`)
      // logic — so warnings can never fail this check, and this file (which
      // has no UnityEditor usage at all) must pass.
      await writeFile(
        join(dir, 'Assets/Warn.cs'),
        'using UnityEngine;\nclass A : MonoBehaviour { void Update() { GetComponent<Rigidbody>(); } }',
      );
      const results = await runChecks([{ type: 'analyzer_clean', glob: 'Assets/*.cs' }], {
        workDir: dir,
        finalAnswer: '',
      });
      expect(results[0].pass).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('evaluates tool_called / tool_not_called against the passed-in toolCalls list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-checks-'));
    try {
      const results = await runChecks(
        [
          { type: 'tool_called', tool: 'unity_api_search' },
          { type: 'tool_not_called', tool: 'get_unity_docs' },
        ],
        { workDir: dir, finalAnswer: '', toolCalls: ['read', 'unity_api_search', 'write'] },
      );
      expect(results.map((r) => r.pass)).toEqual([true, true]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails tool_called when the tool never ran, and fails tool_not_called when it did', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-checks-'));
    try {
      const results = await runChecks(
        [
          { type: 'tool_called', tool: 'unity_api_search' },
          { type: 'tool_not_called', tool: 'write' },
        ],
        { workDir: dir, finalAnswer: '', toolCalls: ['read', 'write'] },
      );
      expect(results.map((r) => r.pass)).toEqual([false, false]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('treats an absent toolCalls list as "no tools were called" rather than throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-checks-'));
    try {
      const results = await runChecks([{ type: 'tool_not_called', tool: 'unity_api_search' }], {
        workDir: dir,
        finalAnswer: '',
      });
      expect(results[0].pass).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Regression test: the ported error-rule logic must match its source
  // (`rules/editor-api-in-runtime.ts`) by scanning the comment/string-blanked
  // `scan.code` view, NOT the raw file text. A `UnityEditor` mention that
  // only appears inside a `//` comment or a string literal is not a real
  // runtime leak and must not produce an error finding.
  it('passes analyzer_clean when UnityEditor is only mentioned in a comment and a string literal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-checks-'));
    try {
      await mkdir(join(dir, 'Assets'), { recursive: true });
      await writeFile(
        join(dir, 'Assets/Commented.cs'),
        [
          'using UnityEngine;',
          'public class Commented : MonoBehaviour {',
          '  // Historical note: this used to call UnityEditor.EditorUtility.DisplayDialog here.',
          '  void Start() {',
          '    string exampleUsing = @"',
          'using UnityEditor;',
          '";',
          '  }',
          '}',
        ].join('\n'),
      );
      const results = await runChecks([{ type: 'analyzer_clean', glob: 'Assets/*.cs' }], {
        workDir: dir,
        finalAnswer: '',
      });
      expect(results[0].pass).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
