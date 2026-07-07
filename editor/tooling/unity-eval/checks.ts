/**
 * Task pass/fail checks. All file paths are relative to the task's workDir
 * (the temp copy of the fixture the agent worked in).
 *
 * ── Why `analyzer_clean` doesn't call `runAnalyzersOnText` ──────────────────
 * The brief for this task called for reusing `runAnalyzersOnText` from the
 * unity-analyzers barrel (`../../src/features/unity-analyzers`), with a
 * documented fallback to the "deeper" module it's re-exported from
 * (`services/analyzer-engine.ts`) if the barrel wasn't Bun-safe. In practice
 * BOTH are unreachable from plain Bun:
 *
 *   - The barrel eagerly initialises Zustand stores, one of which
 *     (`stores/theme.ts`) calls `applyCssVariables` at module scope to avoid
 *     a themed-app FOUC — that dereferences `document`, which doesn't exist
 *     outside a browser.
 *   - `services/analyzer-engine.ts` itself imports `useProjectContextStore`,
 *     which imports `useWorkspaceStore`, which imports `initMonaco` from
 *     `features/editor` — a *value* import of the real `monaco-editor`
 *     package. Loading `monaco-editor` outside a browser throws immediately
 *     (its ESM bundle dereferences `window`/`document` at module scope, e.g.
 *     `mainWindow.location.href` in `vs/base/browser/dom.js`). No exported
 *     symbol of analyzer-engine.ts avoids this — it's a top-level import.
 *
 * This is the same "barrel drags in Monaco" hazard as the graphify barrel,
 * just one level deeper than a single smoke-check anticipates.
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
 * `editor-api-in-runtime` itself can't be imported under Bun either — it
 * imports `refreshAll` *by value* from `analyzer-engine` (to trigger a
 * re-scan after its assembly-resolution promise settles), hitting the same
 * Monaco wall as above. Its core detection (two regexes + an
 * `#if UNITY_EDITOR` / `Editor/`-folder guard, all pure text/scan-based with
 * no Monaco/store dependency) is ported verbatim below. The only behavioural
 * difference from the original is that the asmdef-backed "this file belongs
 * to an editor-only assembly" exemption is dropped — the eval harness has no
 * real asmdef graph to resolve against, so every non-`Editor/`-folder,
 * unguarded usage is treated as a runtime leak.
 *
 * If `rules/editor-api-in-runtime.ts`'s detection patterns change, this port
 * must be updated to match — INCLUDING which view each part reads. The
 * source rule runs both regexes against `scan.code` (the comment/string-
 * blanked view `scanCSharp` produces, so a `UnityEditor` mention inside a
 * `//` comment or a string literal can't false-trigger it — see lines ~52
 * and ~70 of that file), while its `#if UNITY_EDITOR` guard-range parsing
 * reads the raw `scan.text` (line-based scanning needs the real source).
 * This port mirrors that split exactly.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Glob } from 'bun';
import type { Finding } from '../../src/features/unity-analyzers/services/analyzer-engine';
import { scanCSharp, type CSharpScan } from '../../src/features/unity-analyzers/services/csharp-scan';
import type { CheckSpec } from './eval-types';

export interface CheckOutcome {
  spec: CheckSpec;
  pass: boolean;
  detail: string;
}

// ── Ported from rules/editor-api-in-runtime.ts (see module doc above) ──────

const USING_UNITYEDITOR_RE =
  /(^|\n)([ \t]*)using\s+(?:static\s+)?UnityEditor(?:\.[A-Za-z_][\w.]*)?\s*;/g;
const UNITYEDITOR_MEMBER_RE = /\bUnityEditor\s*\.\s*[A-Za-z_]\w*/g;

function isInEditorFolder(filePath: string): boolean {
  return /(^|\/)Editor(\/|$)/.test(filePath.replace(/\\/g, '/'));
}

/** Offsets of regions wrapped in `#if UNITY_EDITOR ... #endif`. */
function unityEditorGuardRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const lines = text.split('\n');
  let offset = 0;
  const stack: Array<{ start: number; editor: boolean }> = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#if\b/.test(trimmed)) {
      stack.push({ start: offset, editor: /\bUNITY_EDITOR\b/.test(trimmed) });
    } else if (/^#endif\b/.test(trimmed)) {
      const top = stack.pop();
      if (top?.editor) ranges.push([top.start, offset + line.length]);
    }
    offset += line.length + 1; // + newline
  }
  return ranges;
}

function editorApiInRuntimeFindings(scan: CSharpScan, filePath: string): Finding[] {
  if (isInEditorFolder(filePath)) return [];
  // Guard-range parsing reads the raw source (line-based scan for `#if`
  // directives); the regex matches below read the comment/string-blanked
  // `scan.code` view — matching the source rule's split exactly.
  const guardedRanges = unityEditorGuardRanges(scan.text);
  const guarded = (offset: number) => guardedRanges.some(([s, e]) => offset >= s && offset < e);
  const findings: Finding[] = [];

  USING_UNITYEDITOR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = USING_UNITYEDITOR_RE.exec(scan.code)) !== null) {
    const lead = m[1] ? m[1].length : 0;
    const start = m.index + lead;
    if (guarded(start)) continue;
    findings.push({
      ruleId: 'unity/editor-api-in-runtime',
      severity: 'error',
      start,
      end: m.index + m[0].length,
      code: 'UNITY0305',
      message:
        "'using UnityEditor;' in a runtime assembly will break player builds. Move this script to an Editor-only assembly/folder, or wrap editor-only code in '#if UNITY_EDITOR'.",
    });
  }

  UNITYEDITOR_MEMBER_RE.lastIndex = 0;
  while ((m = UNITYEDITOR_MEMBER_RE.exec(scan.code)) !== null) {
    if (guarded(m.index)) continue;
    findings.push({
      ruleId: 'unity/editor-api-in-runtime',
      severity: 'error',
      start: m.index,
      end: m.index + m[0].length,
      code: 'UNITY0305',
      message: `'${m[0].replace(/\s+/g, '')}' references the Editor-only UnityEditor namespace from a runtime assembly — this won't compile in a player build. Guard it with '#if UNITY_EDITOR'.`,
    });
  }
  return findings;
}

/** Runs the sole error-severity check `analyzer_clean` needs (see module doc). */
function runErrorRule(text: string, filePath: string): Finding[] {
  const scan = scanCSharp(text);
  return editorApiInRuntimeFindings(scan, filePath);
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
