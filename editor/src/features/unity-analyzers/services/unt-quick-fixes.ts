/**
 * Quick fixes for the Roslyn Unity analyzers' diagnostics.
 *
 * `Microsoft.Unity.Analyzers` ships a `CodeFixProvider` for most of its
 * rules — and csharp-ls does not surface it. Its code-action handler
 * reflects over exactly three Roslyn assemblies (`Microsoft.CodeAnalysis`
 * `.Features`, `.CSharp.Features` and `.Workspaces`) and never looks at the
 * project's analyzer references, so the fixes those analyzers carry are loaded
 * into the process and unreachable.
 *
 * The result without this file is a squiggle that tells you what is wrong and
 * offers nothing — which for `tag == "Player"` is a worse experience than not
 * reporting it, because the fix is mechanical and the user has to type it.
 *
 * So these are reimplemented client-side, from the diagnostic's range alone.
 * Only fixes that are safe to derive that way are here: each one rewrites text
 * the range already contains, with no need to know anything the analyzer knew.
 * A fix that would require type information belongs upstream, not here.
 */

import type { editor } from 'monaco-editor';
import type { LocalCodeAction } from '../../lsp';
import { scanCSharp, type CSharpScan } from './csharp-scan';

/** A Monaco 1-based range, as markers and code-action requests use. */
export interface Range1Based {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface UntFixEdit {
  range: Range1Based;
  newText: string;
}

export interface UntFix {
  title: string;
  edits: UntFixEdit[];
}

/**
 * Build a fix from the text the diagnostic covers.
 *
 * `text` is exactly the source inside `range`. Returning `null` means "this
 * shape is not one I can rewrite safely" — always preferable to a guess, since
 * a quick fix that produces wrong code is worse than no quick fix at all.
 */
type UntFixBuilder = (text: string, range: Range1Based) => UntFix | null;

/** `tag == "Player"` → `CompareTag("Player")` (UNT0002). */
const fixCompareTag: UntFixBuilder = (text, range) => {
  // Either order, `==` or `!=`, with or without a receiver.
  const forward = /^(?:([\w.]+)\s*\.\s*)?tag\s*(==|!=)\s*("(?:[^"\\]|\\.)*")$/.exec(text.trim());
  const reversed = /^("(?:[^"\\]|\\.)*")\s*(==|!=)\s*(?:([\w.]+)\s*\.\s*)?tag$/.exec(text.trim());

  let receiver: string | undefined;
  let op: string;
  let literal: string;
  if (forward) {
    [, receiver, op, literal] = forward;
  } else if (reversed) {
    [, literal, op, receiver] = reversed;
  } else {
    return null;
  }

  const target = receiver ? `${receiver}.CompareTag(${literal})` : `CompareTag(${literal})`;
  return {
    title: `Use CompareTag(${literal})`,
    edits: [{ range, newText: op === '!=' ? `!${target}` : target }],
  };
};

/** `Invoke("Foo")` → `Invoke(nameof(Foo))` (UNT0016). */
const fixNameof: UntFixBuilder = (text, range) => {
  // The analyzer ranges the string literal itself.
  const literal = /^"([A-Za-z_]\w*)"$/.exec(text.trim());
  if (!literal) return null;
  return {
    title: `Use nameof(${literal[1]})`,
    edits: [{ range, newText: `nameof(${literal[1]})` }],
  };
};

/** `GetComponent(typeof(T))` → `GetComponent<T>()` (UNT0003). */
const fixGenericGetComponent: UntFixBuilder = (text, range) => {
  const call =
    /^([\w.]*?\b(?:GetComponent|GetComponentInChildren|GetComponentInParent))\s*\(\s*typeof\s*\(\s*([\w.]+)\s*\)\s*\)$/.exec(
      text.trim(),
    );
  if (!call) return null;
  return {
    title: `Use ${call[1]}<${call[2]}>()`,
    edits: [{ range, newText: `${call[1]}<${call[2]}>()` }],
  };
};

/** `Time.fixedDeltaTime` in Update → `Time.deltaTime` (UNT0004). */
const fixDeltaTime: UntFixBuilder = (text, range) => {
  if (!/^Time\s*\.\s*fixedDeltaTime$/.test(text.trim())) return null;
  return {
    title: "Use 'Time.deltaTime'",
    edits: [{ range, newText: 'Time.deltaTime' }],
  };
};

/**
 * Every UNT diagnostic this module can fix.
 *
 * Deliberately short. Each entry rewrites text the diagnostic's own range
 * already delimits; anything needing the analyzer's semantic model would be
 * guesswork here.
 */
export const UNT_FIXES: Record<string, UntFixBuilder> = {
  UNT0002: fixCompareTag,
  UNT0003: fixGenericGetComponent,
  UNT0004: fixDeltaTime,
  UNT0016: fixNameof,
};

/** Offset of a 1-based line/column in `text`. */
function offsetOf(scan: CSharpScan, line: number, column: number): number {
  const lineStart = scan.lineStarts[line - 1];
  if (lineStart === undefined) return -1;
  return lineStart + (column - 1);
}

/**
 * Fixes for the UNT markers overlapping a code-action request.
 *
 * Pure: it takes the markers and the document text, so the whole mapping is
 * testable without Monaco.
 */
export function untFixesFor(
  text: string,
  markers: Array<{ code?: string; range: Range1Based }>,
): UntFix[] {
  if (markers.length === 0) return [];
  const scan = scanCSharp(text);
  const fixes: UntFix[] = [];

  for (const marker of markers) {
    const code = marker.code;
    if (!code) continue;
    const build = UNT_FIXES[code];
    if (!build) continue;

    const start = offsetOf(scan, marker.range.startLineNumber, marker.range.startColumn);
    const end = offsetOf(scan, marker.range.endLineNumber, marker.range.endColumn);
    if (start < 0 || end < start || end > text.length) continue;

    const fix = build(text.slice(start, end), marker.range);
    if (fix) fixes.push(fix);
  }

  return fixes;
}

/** The marker shape Monaco hands a local code-action source. */
interface MarkerLike {
  code?: string | { value: string };
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

function markerCode(marker: MarkerLike): string | undefined {
  if (typeof marker.code === 'string') return marker.code;
  if (marker.code && typeof marker.code === 'object') return marker.code.value;
  return undefined;
}

/**
 * Adapt Monaco's markers to [`untFixesFor`] and back into code actions.
 *
 * Only markers the language server owns are considered: the TypeScript rules
 * attach their own fixes directly, and a UNITY code must never be routed
 * through a UNT builder.
 */
export function untCodeActionsForModel(
  model: editor.ITextModel,
  markers: MarkerLike[],
): LocalCodeAction[] {
  const uri = model.uri.toString();
  const relevant = markers
    .map((m) => ({ code: markerCode(m), range: m }))
    .filter((m) => m.code !== undefined && /^UNT\d{4}$/.test(m.code));
  if (relevant.length === 0) return [];

  return untFixesFor(model.getValue(), relevant).map((fix) => ({
    title: fix.title,
    kind: 'quickfix',
    isPreferred: true,
    edit: {
      changes: {
        [uri]: fix.edits.map((e) => ({
          range: {
            start: { line: e.range.startLineNumber - 1, character: e.range.startColumn - 1 },
            end: { line: e.range.endLineNumber - 1, character: e.range.endColumn - 1 },
          },
          newText: e.newText,
        })),
      },
    },
  }));
}
