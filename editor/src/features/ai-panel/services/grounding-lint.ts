/**
 * Ask-mode grounding linter (Task P2.2) — the deterministic post-answer half
 * of the contrastive anti-default work started in P2.1 (`prompts/unity-
 * contrast.ts`). Prompt facts alone don't reliably beat a strong training
 * prior; this module re-checks the model's OWN answer against the same
 * `wrongTokens`/`correction` table and produces a short, imperative revise
 * instruction when it finds a wrong-for-this-project API actually IN USE.
 *
 * PURE and Bun-safe: imports only `prompts/unity-contrast` + std lib, so the
 * eval harness (`tooling/unity-eval/run-task.ts`) can import it directly
 * under plain Bun, exactly like `unity-contrast.ts` itself.
 *
 * ---------------------------------------------------------------------------
 * Code-scoping rule (the false-positive control)
 * ---------------------------------------------------------------------------
 * A correct answer is allowed to explain "don't use `_Color` here" — that's a
 * prose MENTION of the wrong token, not a USE of it. So this linter never
 * scans raw prose. It only ever looks inside two regions of the answer:
 *
 *  1. Fenced code blocks (``` … ```). These are real code, so the block-
 *     level scoping IS the false-positive control: every `wrongTokens`
 *     pattern is matched against the block's full text. The one wrinkle
 *     (found by P2.1's reviewer) is that a negation comment INSIDE a fenced
 *     block — e.g. `// don't use _Color, use _BaseColor` — would otherwise
 *     false-positive, so `//…` (to end of line) and `/*…*\/` spans are
 *     stripped from each fenced block before matching.
 *
 *  2. Inline code spans (`…`). These are much shorter and far more likely to
 *     be a bare mention ("don't use `_Color`") than real usage, so a single
 *     extra gate applies BEFORE any pattern is tested against a span: the
 *     span's own text must look like a usage form — it contains a call/
 *     grouping paren `(` (e.g. `` `Input.GetAxis("Horizontal")` ``,
 *     `` `SetColor("_Color", ...)` ``) or a `using` directive (e.g.
 *     `` `using UnityEngine.InputSystem;` ``). A bare identifier or bare
 *     quoted string span (`` `_Color` ``, `` `InputAction` ``) never passes
 *     this gate, so it can never match regardless of which row's pattern it
 *     might otherwise resemble — that's what keeps "don't use `_Color`"
 *     clean. Spans that DO pass the gate are matched the same way fenced
 *     blocks are (full `wrongTokens` set, no comment-stripping needed since
 *     inline spans are single-line).
 *
 * Anything outside a fence or inline span — plain prose — is never matched,
 * even if it happens to contain a wrong token verbatim.
 */

import { contrastRows, type ContrastFacts, type ContrastRow } from './prompts/unity-contrast';

export interface Violation {
  rowId: string;
  matchedText: string;
  correction: string;
}

// Fenced block: opening ``` (optional language tag) + newline, non-greedy
// body, closing ```. `s` flag lets `.` inside `[\s\S]` alternatives, but we
// stick to `[\s\S]*?` for portability.
const FENCE_RE = /```[^\n`]*\n([\s\S]*?)```/g;
// Inline span: single backtick pair, no newline inside (matches CommonMark's
// short-span convention closely enough for this scope).
const INLINE_SPAN_RE = /`([^`\n]+)`/g;

const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /\/\/[^\n]*/g;

/** Strip `//…` (to end of line) and `/*…*\/` spans from a fenced-block body. */
function stripComments(code: string): string {
  return code.replace(BLOCK_COMMENT_RE, '').replace(LINE_COMMENT_RE, '');
}

/**
 * The inline-span usage-form gate: does this span's own text look like real
 * code being invoked/imported, rather than a bare identifier or quoted
 * property name mentioned in passing? See the module header for why this is
 * the false-positive control for inline spans specifically.
 */
function isUsageForm(span: string): boolean {
  return span.includes('(') || /\busing\s+/.test(span);
}

/** First substring in `text` matched by any of the row's `wrongTokens`, or null. */
function firstMatch(row: ContrastRow, text: string): string | null {
  for (const token of row.wrongTokens) {
    const re = new RegExp(token.pattern, token.flags ?? '');
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

/** Fenced-code-block bodies (comments stripped), in document order. */
function extractCodeBlocks(text: string): { blocks: string[]; spans: Array<[number, number]> } {
  const blocks: string[] = [];
  const spans: Array<[number, number]> = [];
  FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(text))) {
    blocks.push(stripComments(m[1] ?? ''));
    spans.push([m.index, m.index + m[0].length]);
  }
  return { blocks, spans };
}

/** Inline-span bodies that pass the usage-form gate, searched OUTSIDE the given fenced ranges. */
function extractUsageFormSpans(text: string, fencedSpans: Array<[number, number]>): string[] {
  let withoutFences = text;
  if (fencedSpans.length > 0) {
    let out = '';
    let cursor = 0;
    for (const [start, end] of fencedSpans) {
      out += text.slice(cursor, start);
      cursor = end;
    }
    out += text.slice(cursor);
    withoutFences = out;
  }

  const spans: string[] = [];
  INLINE_SPAN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_SPAN_RE.exec(withoutFences))) {
    const span = m[1] ?? '';
    if (isUsageForm(span)) spans.push(span);
  }
  return spans;
}

/**
 * Lint an assistant answer for wrong-for-this-project API usage, scoped to
 * fenced code blocks and usage-form inline spans only (see module header).
 * Returns one `Violation` per applicable contrast row that matched (deduped
 * by `rowId` — a row can only ever contribute a single violation, no matter
 * how many times or where its pattern matches).
 */
export function lintAnswer(text: string, facts: ContrastFacts): Violation[] {
  const rows = contrastRows(facts);
  if (rows.length === 0) return [];

  const { blocks: codeBlocks, spans: fencedSpans } = extractCodeBlocks(text);
  const usageSpans = extractUsageFormSpans(text, fencedSpans);

  const violations: Violation[] = [];
  for (const row of rows) {
    let matched: string | null = null;
    for (const block of codeBlocks) {
      matched = firstMatch(row, block);
      if (matched) break;
    }
    if (!matched) {
      for (const span of usageSpans) {
        matched = firstMatch(row, span);
        if (matched) break;
      }
    }
    if (matched) {
      violations.push({ rowId: row.id, matchedText: matched, correction: row.correction });
    }
  }
  return violations;
}

/**
 * Build the single forced revise-turn message. Imperative and short by
 * design (this is not a conversational turn — it's a correction directive).
 * Prefixed with `[grounding-check]` so the marker is greppable in transcripts
 * / telemetry, matching the `[Unity compile]` / `[Unity analyzers]` marker
 * convention already used by the other post-hoc feedback loops.
 */
export function buildReviseMessage(violations: Violation[]): string {
  const bullets = violations.map((v) => `- ${v.matchedText}: ${v.correction}`).join('\n');
  return (
    `[grounding-check] Your answer uses APIs that are wrong for this project:\n${bullets}\n` +
    `Rewrite the affected code/answer using the corrections. Keep everything else unchanged.`
  );
}
