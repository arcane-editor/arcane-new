/**
 * Task pass/fail checks. All file paths are relative to the task's workDir
 * (the temp copy of the fixture the agent worked in).
 *
 * ── What `analyzer_clean` actually gates on ─────────────────────────────────
 * `analyzer_clean` only ever fails a task on `error`-severity findings (see
 * the `analyzer_clean` case in `runOne` below — it filters
 * `f.severity === 'error'`). Of the 13 rules `register-rules.ts` registers,
 * `editor-api-in-runtime` is the *only* one whose `defaultSeverity` is
 * `'error'` — every other rule defaults to `warning`/`info` (see
 * `fixtures/analyzers/CorrectnessRules.cs`, which documents it as the sole
 * "EXPECTED: ERROR" case). That means no warning/info rule can ever change
 * this check's outcome, however it's implemented — so this file does not
 * import or run any of them. (An earlier version of this file directly
 * imported 10 Bun-safe warning/info rule modules and ran them for parity
 * with the real engine; they were removed as dead weight — they could never
 * flip `analyzer_clean`'s result, and importing rule modules by path also
 * bypassed the `unity-analyzers` feature's barrel.)
 *
 * The `editor-api-in-runtime` detection itself — a Bun-safe PORT, not an
 * import, of `rules/editor-api-in-runtime.ts` (Monaco/store dependencies
 * make the original unimportable under plain Bun) — lives in
 * `analyzer-rule.ts` (`runErrorRule`), shared with `eval-gates.ts`'s
 * `withEvalAnalyzerGate`. See that file's header for the full "why a port"
 * investigation and the exact behavioural deltas from the source rule.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Glob } from 'bun';
import { runErrorRule } from './analyzer-rule';
import type { CheckSpec } from './eval-types';

export interface CheckOutcome {
  spec: CheckSpec;
  pass: boolean;
  detail: string;
}

async function tryRead(workDir: string, rel: string): Promise<string | null> {
  try {
    return await readFile(join(workDir, rel), 'utf8');
  } catch {
    return null;
  }
}

async function runOne(
  spec: CheckSpec,
  ctx: { workDir: string; finalAnswer: string },
): Promise<CheckOutcome> {
  switch (spec.type) {
    case 'file_exists': {
      const content = await tryRead(ctx.workDir, spec.path);
      return {
        spec,
        pass: content !== null,
        detail: content === null ? `missing: ${spec.path}` : 'exists',
      };
    }
    case 'file_contains':
    case 'file_not_contains': {
      const content = await tryRead(ctx.workDir, spec.path);
      if (content === null) return { spec, pass: false, detail: `missing: ${spec.path}` };
      const hit = new RegExp(spec.pattern, spec.flags).test(content);
      const want = spec.type === 'file_contains';
      return { spec, pass: hit === want, detail: `pattern ${hit ? 'found' : 'not found'} in ${spec.path}` };
    }
    case 'analyzer_clean': {
      const errors: string[] = [];
      for await (const rel of new Glob(spec.glob).scan({ cwd: ctx.workDir })) {
        const text = await readFile(join(ctx.workDir, rel), 'utf8');
        const findings = runErrorRule(text, rel);
        for (const f of findings) {
          if (f.severity === 'error') errors.push(`${rel}: ${f.message}`);
        }
      }
      return { spec, pass: errors.length === 0, detail: errors.slice(0, 5).join(' | ') };
    }
    case 'answer_matches':
    case 'answer_not_matches': {
      const hit = new RegExp(spec.pattern, spec.flags).test(ctx.finalAnswer);
      const want = spec.type === 'answer_matches';
      return { spec, pass: hit === want, detail: `answer pattern ${hit ? 'matched' : 'did not match'}` };
    }
  }
}

export async function runChecks(
  specs: CheckSpec[],
  ctx: { workDir: string; finalAnswer: string },
): Promise<CheckOutcome[]> {
  const out: CheckOutcome[] = [];
  for (const spec of specs) out.push(await runOne(spec, ctx));
  return out;
}
