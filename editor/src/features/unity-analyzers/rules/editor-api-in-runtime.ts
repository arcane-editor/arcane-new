import type { AnalyzerRule, Finding, RuleContext } from '../services/analyzer-engine';
import { refreshAll } from '../services/analyzer-engine';
import { type CSharpScan } from '../services/csharp-scan';
import { useAsmdefStore } from '../../../stores/asmdef';
import { buildEdit, type PendingEdit } from '../services/fix-helpers';

// `using UnityEditor;` directive, and any `UnityEditor.` member access.
const USING_UNITYEDITOR_RE = /(^|\n)([ \t]*)using\s+(?:static\s+)?UnityEditor(?:\.[A-Za-z_][\w.]*)?\s*;/g;
const UNITYEDITOR_MEMBER_RE = /\bUnityEditor\s*\.\s*[A-Za-z_]\w*/g;

// Predefined runtime assemblies that have no asmdef but are NOT editor-only.
const RUNTIME_PREDEFINED = new Set(['Assembly-CSharp', 'Assembly-CSharp-firstpass']);

/**
 * Using UnityEditor APIs in a RUNTIME assembly breaks player builds (the
 * UnityEditor namespace doesn't exist outside the Editor). This is an ERROR
 * unless the file is in an Editor-only assembly, an `Editor/` folder, or the
 * usage is wrapped in `#if UNITY_EDITOR`.
 *
 * Assembly resolution is async (asmdef store), but rule.run is sync, so we read
 * the store's cached owning-assembly map. On a cache miss we conservatively do
 * NOT flag (avoid false errors) and kick off a background resolution that
 * re-runs analysis once the answer is cached.
 */
export const editorApiInRuntimeRule: AnalyzerRule = {
  id: 'unity/editor-api-in-runtime',
  defaultSeverity: 'error',

  run(scan, ctx): Finding[] {
    const filePath = ctx.filePath;

    // Files physically under an `Editor/` folder are always editor-only.
    if (isInEditorFolder(filePath)) return [];

    const owner = resolveOwnerSync(filePath, ctx);
    // Unknown owner → stay silent (a background resolve will re-trigger us).
    if (owner === undefined) return [];

    // Editor-only assembly → fine.
    if (owner !== null && isEditorOnlyAssembly(owner)) return [];

    // Find the bounds covered by #if UNITY_EDITOR so we can exempt them.
    const editorGuardedRanges = unityEditorGuardRanges(scan);
    const guarded = (offset: number) =>
      editorGuardedRanges.some(([s, e]) => offset >= s && offset < e);

    const findings: Finding[] = [];

    // 1) `using UnityEditor;` outside a guard.
    USING_UNITYEDITOR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = USING_UNITYEDITOR_RE.exec(scan.code)) !== null) {
      const lead = m[1] ? m[1].length : 0;
      const start = m.index + lead;
      const end = m.index + m[0].length;
      if (guarded(start)) continue;
      findings.push({
        ruleId: this.id,
        severity: this.defaultSeverity,
        start,
        end,
        code: 'UNITY0305',
        message: `'using UnityEditor;' in a runtime assembly will break player builds. Move this script to an Editor-only assembly/folder, or wrap editor-only code in '#if UNITY_EDITOR'.`,
        fixes: buildWrapFileFix(scan, ctx.model),
      });
    }

    // 2) `UnityEditor.Xxx` member access outside a guard.
    UNITYEDITOR_MEMBER_RE.lastIndex = 0;
    while ((m = UNITYEDITOR_MEMBER_RE.exec(scan.code)) !== null) {
      const start = m.index;
      if (guarded(start)) continue;
      findings.push({
        ruleId: this.id,
        severity: this.defaultSeverity,
        start,
        end: start + m[0].length,
        code: 'UNITY0305',
        message: `'${m[0].replace(/\s+/g, '')}' references the Editor-only UnityEditor namespace from a runtime assembly — this won't compile in a player build. Guard it with '#if UNITY_EDITOR'.`,
        fixes: buildWrapFileFix(scan, ctx.model),
      });
    }

    return findings;
  },
};

function isInEditorFolder(filePath: string): boolean {
  return /(^|\/)Editor(\/|$)/.test(filePath.replace(/\\/g, '/'));
}

/**
 * Read the asmdef store's cached owning-assembly for the file. Returns:
 *   string  — resolved assembly name
 *   null    — resolved, but no owner (treat as runtime; predefined assembly)
 *   undefined — not yet cached (caller stays silent + we background-resolve)
 */
function resolveOwnerSync(filePath: string, ctx: RuleContext): string | null | undefined {
  const store = useAsmdefStore.getState();
  const cached = store.byFile.get(filePath);
  if (cached !== undefined) {
    // Predefined runtime assembly counts as a real (runtime) owner.
    return cached;
  }
  // Miss: resolve in the background, then re-run analysis for open models.
  void store.getOwningAssembly(filePath).then(() => {
    if (ctx.monaco) refreshAll(ctx.monaco);
  });
  return undefined;
}

function isEditorOnlyAssembly(owner: string): boolean {
  if (RUNTIME_PREDEFINED.has(owner)) return false;
  const node = useAsmdefStore.getState().graph.find((n) => n.name === owner);
  return node?.is_editor_only === true;
}

/**
 * Offsets of regions wrapped in `#if UNITY_EDITOR ... #endif` (also accepts
 * `#if UNITY_EDITOR || ...`). Best-effort line-based scan over the original text.
 */
function unityEditorGuardRanges(scan: CSharpScan): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const text = scan.text;
  const lines = text.split('\n');
  let offset = 0;
  const stack: Array<{ start: number; editor: boolean }> = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#if\b/.test(trimmed)) {
      const isEditor = /\bUNITY_EDITOR\b/.test(trimmed);
      stack.push({ start: offset, editor: isEditor });
    } else if (/^#endif\b/.test(trimmed)) {
      const top = stack.pop();
      if (top && top.editor) {
        ranges.push([top.start, offset + line.length]);
      }
    }
    offset += line.length + 1; // + newline
  }
  return ranges;
}

/**
 * Quick-fix: wrap the WHOLE file in `#if UNITY_EDITOR ... #endif`. This is the
 * always-compiles fallback (the file becomes editor-only at compile time).
 */
function buildWrapFileFix(
  scan: CSharpScan,
  model: Parameters<typeof buildEdit>[1],
): Finding['fixes'] {
  if (!model) return undefined;
  const text = scan.text;
  const endNewline = text.endsWith('\n') ? '' : '\n';
  const edits: PendingEdit[] = [
    { start: 0, end: 0, newText: '#if UNITY_EDITOR\n' },
    { start: text.length, end: text.length, newText: `${endNewline}#endif\n` },
  ];
  const edit = buildEdit(scan, model, edits);
  if (!edit) return undefined;
  return [{ title: "Wrap file in '#if UNITY_EDITOR'", isPreferred: true, edit }];
}
