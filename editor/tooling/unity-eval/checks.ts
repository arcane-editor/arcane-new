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
 * Fix: import the individual RULE modules directly, bypassing the engine's
 * registry, and replicate the same trivial "scan text, run each rule, collect
 * findings" loop `runAnalyzersOnText` uses (that loop itself has zero
 * Monaco/store dependency — only the module that also hosts it does). Of the
 * 13 rules `register-rules.ts` registers, 10 import cleanly under Bun:
 * `getcomponent-in-update`, `camera-main`, `string-apis`, `alloc-in-update`,
 * `deltatime-in-fixedupdate`, `null-propagation-unity-object`, `destroy-this`,
 * `transform-position-per-axis`, `waitforseconds-in-loop`,
 * `non-serializable-types`. Three do not:
 *   - `near-miss-messages` / `empty-messages` import `LIFECYCLE_METHOD_NAMES`
 *     from the `../../csharp` barrel, which re-exports React components
 *     (`NewScriptModal`, `class-rename-sync`) that import `useWorkspaceStore`
 *     directly — same Monaco wall as above.
 *   - `editor-api-in-runtime` imports `refreshAll` *by value* from
 *     `analyzer-engine` (to trigger a re-scan after its assembly-resolution
 *     promise settles) — same wall again.
 *
 * `editor-api-in-runtime` also happens to be the *only* rule whose
 * `defaultSeverity` is `'error'` (the rest are `warning`/`info` — see
 * `fixtures/analyzers/CorrectnessRules.cs`, which documents it as the sole
 * "EXPECTED: ERROR" case). Since it can't be loaded in Bun, and the eval
 * harness needs at least one real `error`-severity signal for `analyzer_clean`
 * to ever fail on, its core detection (two regexes + an `#if UNITY_EDITOR` /
 * `Editor/`-folder guard, all pure text scanning with no Monaco/store
 * dependency) is ported verbatim below. The only behavioural difference from
 * the original is that the asmdef-backed "this file belongs to an
 * editor-only assembly" exemption is dropped — the eval harness has no real
 * asmdef graph to resolve against, so every non-`Editor/`-folder, unguarded
 * usage is treated as a runtime leak. If `rules/editor-api-in-runtime.ts`'s
 * detection patterns change, this port must be updated to match.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Glob } from 'bun';
import type {
  AnalyzerRule,
  Finding,
  RuleContext,
} from '../../src/features/unity-analyzers/services/analyzer-engine';
import { scanCSharp } from '../../src/features/unity-analyzers/services/csharp-scan';
import { getComponentInUpdateRule } from '../../src/features/unity-analyzers/rules/getcomponent-in-update';
import { cameraMainRule } from '../../src/features/unity-analyzers/rules/camera-main';
import { stringApisRule } from '../../src/features/unity-analyzers/rules/string-apis';
import { allocInUpdateRule } from '../../src/features/unity-analyzers/rules/alloc-in-update';
import { deltaTimeInFixedUpdateRule } from '../../src/features/unity-analyzers/rules/deltatime-in-fixedupdate';
import { nullPropagationUnityObjectRule } from '../../src/features/unity-analyzers/rules/null-propagation-unity-object';
import { destroyThisRule } from '../../src/features/unity-analyzers/rules/destroy-this';
import { transformPositionPerAxisRule } from '../../src/features/unity-analyzers/rules/transform-position-per-axis';
import { waitForSecondsInLoopRule } from '../../src/features/unity-analyzers/rules/waitforseconds-in-loop';
import { nonSerializableTypesRule } from '../../src/features/unity-analyzers/rules/non-serializable-types';
import type { CheckSpec } from './eval-types';

export interface CheckOutcome {
  spec: CheckSpec;
  pass: boolean;
  detail: string;
}

// Bun-safe subset of the registered analyzer rules — see module doc above.
const SAFE_RULES: AnalyzerRule[] = [
  getComponentInUpdateRule,
  cameraMainRule,
  stringApisRule,
  allocInUpdateRule,
  deltaTimeInFixedUpdateRule,
  nullPropagationUnityObjectRule,
  destroyThisRule,
  transformPositionPerAxisRule,
  waitForSecondsInLoopRule,
  nonSerializableTypesRule,
];

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

function editorApiInRuntimeFindings(text: string, filePath: string): Finding[] {
  if (isInEditorFolder(filePath)) return [];
  const guardedRanges = unityEditorGuardRanges(text);
  const guarded = (offset: number) => guardedRanges.some(([s, e]) => offset >= s && offset < e);
  const findings: Finding[] = [];

  USING_UNITYEDITOR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = USING_UNITYEDITOR_RE.exec(text)) !== null) {
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
  while ((m = UNITYEDITOR_MEMBER_RE.exec(text)) !== null) {
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

/** Bun-safe stand-in for `runAnalyzersOnText` (see module doc for why). */
function runSafeAnalyzers(text: string, filePath: string): Finding[] {
  const scan = scanCSharp(text);
  const ctx: RuleContext = { model: null, filePath, unityVersion: null, monaco: null };
  const findings: Finding[] = [];
  for (const rule of SAFE_RULES) {
    try {
      findings.push(...rule.run(scan, ctx));
    } catch {
      // Rules must never throw; skip defensively, mirroring the real engine.
    }
  }
  findings.push(...editorApiInRuntimeFindings(text, filePath));
  return findings;
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
        const findings = runSafeAnalyzers(text, rel);
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
