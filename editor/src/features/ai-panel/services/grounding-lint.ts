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
 *  1. Fenced code blocks (``` … ``` or ~~~ … ~~~). These are real code, so the
 *     block-level scoping IS the false-positive control: every `wrongTokens`
 *     pattern is matched against the block's full text. Fences may be paired or
 *     unclosed (if the answer is truncated or incomplete, the rest of the text
 *     is treated as the block body). The one wrinkle (found by P2.1's reviewer)
 *     is that a negation comment INSIDE a fenced block — e.g.
 *     `// don't use _Color, use _BaseColor` — would otherwise false-positive,
 *     so `//…` (to end of line) and `/*…*\/` spans are stripped from each
 *     fenced block before matching.
 *
 *  2. Inline code spans (`…`). These are much shorter and far more likely to
 *     be a bare mention ("don't use `_Color`") than real usage. To reduce
 *     false positives, inline spans are only matched against `wrongTokens`
 *     patterns that themselves encode usage syntax — patterns containing
 *     `\(` or `using\s` (e.g., call-forms like `SetColor\(\s*"_Color"`,
 *     `Input\.(GetAxis|…)`, `using\s+UnityEngine\.InputSystem`). Bare
 *     quoted-string and bare-identifier patterns (`` `_Color` ``,
 *     `` `InputAction` ``) apply only inside fenced blocks, not inline.
 *     This ensures that "don't use `_Color`" in prose stays clean.
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
 * Does this pattern string encode usage syntax (call, method reference, or import)?
 * Returns false only for "bare mention" patterns — those that match ONLY a quoted
 * string or ONLY a bare identifier with word boundaries. All other patterns
 * (containing structure like `\.`, `\(`, `using`, `\s`, `:`, etc.) are usage patterns.
 */
function isUsagePattern(pattern: string): boolean {
  // Bare quoted string: "_Color", "_BaseColor", "_MainTex", "_BaseMap"
  if (/^"[^"]*"$/.test(pattern)) {
    return false;
  }
  // Bare word with boundaries: \bInputAction\b, \bPlayerInput\b
  // (the pattern string contains literal backslash-b sequences)
  if (/^\\b\w+\\b$/.test(pattern)) {
    return false;
  }
  // Everything else (containing method references, calls, imports, etc.) is a usage pattern
  return true;
}

/** First substring in `text` matched by any of the given tokens, or null. */
function firstMatch(tokens: readonly typeof ContrastRow.prototype.wrongTokens[number][], text: string): string | null {
  for (const token of tokens) {
    const re = new RegExp(token.pattern, token.flags ?? '');
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

/**
 * Fenced-code-block bodies (comments stripped), in document order.
 * Supports both ``` and ~~~ fence types. Handles both paired and unclosed fences
 * (unclosed fences treat the rest of the text as the block body).
 */
function extractCodeBlocks(text: string): { blocks: string[]; spans: Array<[number, number]> } {
  const blocks: string[] = [];
  const spans: Array<[number, number]> = [];

  let pos = 0;
  const openFencePattern = /^(```|~~~)[^\n]*\n/m;

  while (pos < text.length) {
    const openMatch = openFencePattern.exec(text.slice(pos));
    if (!openMatch) break;

    const fenceType = openMatch[1]!;
    const spanStart = pos + openMatch.index;
    const contentStart = pos + openMatch.index + openMatch[0].length;

    // Look for closing fence of the same type at the start of a line
    const closePattern = new RegExp(`^${fenceType.replace(/`/g, '\\`')}`, 'm');
    const closeMatch = closePattern.exec(text.slice(contentStart));

    let spanEnd: number;
    let contentEnd: number;

    if (closeMatch) {
      // Found closing fence
      contentEnd = contentStart + closeMatch.index;
      // Skip to end of closing fence line
      const afterClose = contentStart + closeMatch.index + fenceType.length;
      const nextNewline = text.indexOf('\n', afterClose);
      spanEnd = nextNewline === -1 ? text.length : nextNewline + 1;
    } else {
      // Unclosed fence: rest of text is content
      contentEnd = text.length;
      spanEnd = text.length;
    }

    const body = text.substring(contentStart, contentEnd);
    blocks.push(stripComments(body));
    spans.push([spanStart, spanEnd]);

    pos = spanEnd;
  }

  return { blocks, spans };
}

/** All inline-span bodies (no gate), searched OUTSIDE the given fenced ranges. */
function extractAllInlineSpans(text: string, fencedSpans: Array<[number, number]>): string[] {
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
    spans.push(m[1] ?? '');
  }
  return spans;
}

/**
 * Lint an assistant answer for wrong-for-this-project API usage, scoped to
 * fenced code blocks and inline spans only (see module header).
 * Returns one `Violation` per applicable contrast row that matched (deduped
 * by `rowId` — a row can only ever contribute a single violation, no matter
 * how many times or where its pattern matches).
 */
export function lintAnswer(text: string, facts: ContrastFacts): Violation[] {
  const rows = contrastRows(facts);
  if (rows.length === 0) return [];

  const { blocks: codeBlocks, spans: fencedSpans } = extractCodeBlocks(text);
  const allInlineSpans = extractAllInlineSpans(text, fencedSpans);

  const violations: Violation[] = [];
  for (const row of rows) {
    let matched: string | null = null;

    // Check fenced blocks with all patterns
    for (const block of codeBlocks) {
      matched = firstMatch(row.wrongTokens, block);
      if (matched) break;
    }

    // Check inline spans, but only with patterns that encode usage syntax
    if (!matched) {
      const usagePatterns = row.wrongTokens.filter((t) => isUsagePattern(t.pattern));
      for (const span of allInlineSpans) {
        matched = firstMatch(usagePatterns, span);
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
