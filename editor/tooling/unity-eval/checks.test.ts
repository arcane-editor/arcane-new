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
      // GetComponent-in-Update is a real, reachable rule that only ever
      // reports at `warning` severity — confirms analyzer_clean only fails
      // on `error`-severity findings, not on warnings/info.
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
});
