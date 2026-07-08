/**
 * Bun-safe PORT of the one error-severity Unity analyzer rule
 * (`rules/editor-api-in-runtime.ts`): `using UnityEditor;` / `UnityEditor.*`
 * usage leaking into a runtime assembly, which breaks player builds.
 *
 * ── Why this is a port, not an import ───────────────────────────────────────
 * The brief for the original `checks.ts` work called for reusing
 * `runAnalyzersOnText` from the unity-analyzers barrel
 * (`../../src/features/unity-analyzers`), with a documented fallback to the
 * "deeper" module it's re-exported from (`services/analyzer-engine.ts`) if
 * the barrel wasn't Bun-safe. In practice BOTH are unreachable from plain
 * Bun:
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
 *
 * ── Who uses this ────────────────────────────────────────────────────────
 * `checks.ts`'s `analyzer_clean` check (only ever gates on `error`-severity
 * findings — this rule is the only one with `defaultSeverity: 'error'`, see
 * that file's own header) and `eval-gates.ts`'s `withEvalAnalyzerGate`
 * decorator (the eval's analog of production's analyzer gate,
 * `src/features/ai-panel/services/unity-tools/analyzer-gate.ts`).
 */

import type { Finding } from '../../src/features/unity-analyzers/services/analyzer-engine';
import { scanCSharp, type CSharpScan } from '../../src/features/unity-analyzers/services/csharp-scan';

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

/** Runs the sole error-severity check this port needs (see module doc). */
export function runErrorRule(text: string, filePath: string): Finding[] {
  const scan = scanCSharp(text);
  return editorApiInRuntimeFindings(scan, filePath);
}
