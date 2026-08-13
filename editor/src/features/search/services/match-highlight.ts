// Inserts <mark class="search-match-highlight"> into already-tokenized HTML
// (Monaco's `colorize()` output for one line) at exact UTF-16 offsets, so a
// line containing a search match keeps its syntax colours instead of falling
// back to plain, uncoloured spans. See `FileExcerptBlock.tsx` for why this
// exists: `colorize` returns HTML, but match highlighting needs offsets into
// the line's plain text, and those offsets do not survive tokenization.
//
// No DOM here — this runs under `bun:test`, which has no `document`/
// `DOMParser`. The HTML this module ever receives comes from Monaco's
// `renderViewLine2` (see `monaco-editor/esm/vs/editor/common/viewLayout/
// viewLineRenderer.js`), which only ever escapes four things in text content:
// `&`, `<`, `>`, and NUL (`&#00;`). Decoding/re-encoding exactly that set is
// what keeps this a lossless round trip — see `decodeHtmlText`/`escapeHtml`.
import type { MatchRange } from './excerpt-model';

export const SEARCH_MATCH_MARK_CLASS = 'search-match-highlight';

interface TextNode {
  type: 'text';
  value: string;
}

interface ElementNode {
  type: 'element';
  tag: string;
  /** Raw attribute string as it appeared in the source, including its
   *  leading space (e.g. ` class="mtk1"`) — echoed back verbatim so
   *  reconstruction never has to guess at spacing or attribute order. */
  attrs: string;
  children: HtmlNode[];
}

type HtmlNode = TextNode | ElementNode;

const TAG_RE = /<(\/?)([a-zA-Z][\w-]*)([^<>]*)>/g;

/** Parses a small, constrained subset of HTML — the flat/shallow structure
 *  Monaco's colorizer emits (an outer `<span>` wrapping a run of
 *  `<span class="mtkN">text</span>` tokens) — into a node tree. Malformed
 *  input (an unmatched closing tag) degrades gracefully rather than
 *  throwing: extra closes are ignored once the stack is back at the root. */
function parseHtml(html: string): HtmlNode[] {
  const root: HtmlNode[] = [];
  const stack: HtmlNode[][] = [root];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(html))) {
    const [full, closingSlash, tag, rawAttrs] = m;
    if (m.index > lastIndex) {
      pushText(stack[stack.length - 1], html.slice(lastIndex, m.index));
    }
    lastIndex = TAG_RE.lastIndex;
    if (closingSlash) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const selfClosing = /\/\s*$/.test(rawAttrs) || full.endsWith('/>');
    const attrs = rawAttrs.replace(/\/\s*$/, '');
    const el: ElementNode = { type: 'element', tag, attrs, children: [] };
    stack[stack.length - 1].push(el);
    if (!selfClosing) stack.push(el.children);
  }
  if (lastIndex < html.length) {
    pushText(stack[stack.length - 1], html.slice(lastIndex));
  }
  return root;
}

function pushText(target: HtmlNode[], raw: string): void {
  if (!raw) return;
  target.push({ type: 'text', value: decodeHtmlText(raw) });
}

function decodeHtmlText(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const code = isHex ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : whole;
    }
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      case 'nbsp':
        return '\u00A0';
      default:
        return whole; // unknown entity: leave the source text untouched
    }
  });
}

/** Mirrors exactly what Monaco's own renderer escapes in text content (see
 *  the module doc comment), so re-encoding decoded text is the exact inverse
 *  of `decodeHtmlText` for anything colorize can actually produce. `&` is
 *  replaced first so the entities this inserts are never themselves escaped. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\u0000/g, '&#00;');
}

interface Run {
  text: string;
  /** Ancestor chain, outermost to innermost, excluding the implicit root. */
  path: ElementNode[];
  /** Cumulative UTF-16 offset of this run's first character in the line. */
  start: number;
}

function flatten(nodes: HtmlNode[], path: ElementNode[], runs: Run[], cursor: { offset: number }): void {
  for (const node of nodes) {
    if (node.type === 'text') {
      if (node.value.length > 0) {
        runs.push({ text: node.value, path, start: cursor.offset });
        cursor.offset += node.value.length;
      }
    } else {
      flatten(node.children, [...path, node], runs, cursor);
    }
  }
}

interface NormalizedRange {
  start: number;
  end: number;
}

/** Clamps, drops zero-width/out-of-range entries, and drops overlaps in
 *  favour of the earlier range — the exact policy `splitByMatches` in
 *  `highlight.ts` already applies, kept identical here so the cold-path
 *  match line and the plain-text fallback never disagree about which ranges
 *  count. */
function normalizeRanges(ranges: MatchRange[], total: number): NormalizedRange[] {
  const sorted = [...ranges]
    .map((r) => ({ start: Math.max(0, r.start), end: Math.min(total, r.end) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);

  const result: NormalizedRange[] = [];
  let cursor = 0;
  for (const r of sorted) {
    if (r.start < cursor) continue; // overlapping range: keep the first
    result.push(r);
    cursor = r.end;
  }
  return result;
}

interface Piece {
  text: string;
  path: ElementNode[];
  /** Index into the normalized ranges array, or -1 for unmatched text. */
  markGroup: number;
}

/** Splits each run's text at every normalized range boundary that falls
 *  inside it, tagging the pieces that fall within a range with that range's
 *  index. A range spanning two runs (two token spans) keeps the SAME index
 *  across both — that shared index is what lets `serialize` below wrap them
 *  in one <mark> instead of two. */
function splitRuns(runs: Run[], ranges: NormalizedRange[]): Piece[] {
  const pieces: Piece[] = [];
  let ri = 0;
  for (const run of runs) {
    const runEnd = run.start + run.text.length;
    let cursor = run.start;
    while (cursor < runEnd) {
      const range = ri < ranges.length ? ranges[ri] : null;
      if (!range || range.start >= runEnd) {
        pieces.push({ text: run.text.slice(cursor - run.start), path: run.path, markGroup: -1 });
        cursor = runEnd;
        break;
      }
      if (cursor < range.start) {
        const sliceEnd = Math.min(range.start, runEnd);
        pieces.push({
          text: run.text.slice(cursor - run.start, sliceEnd - run.start),
          path: run.path,
          markGroup: -1,
        });
        cursor = sliceEnd;
        continue;
      }
      // cursor is within [range.start, range.end): emit the matched slice.
      const sliceEnd = Math.min(range.end, runEnd);
      if (sliceEnd > cursor) {
        pieces.push({
          text: run.text.slice(cursor - run.start, sliceEnd - run.start),
          path: run.path,
          markGroup: ri,
        });
      }
      cursor = sliceEnd;
      if (cursor >= range.end) ri++;
    }
  }
  return pieces;
}

function renderPiece(piece: Piece): string {
  let out = escapeHtml(piece.text);
  for (let i = piece.path.length - 1; i >= 0; i--) {
    const el = piece.path[i];
    out = `<${el.tag}${el.attrs}>${out}</${el.tag}>`;
  }
  return out;
}

function serialize(pieces: Piece[]): string {
  let html = '';
  let i = 0;
  while (i < pieces.length) {
    const group = pieces[i].markGroup;
    if (group === -1) {
      html += renderPiece(pieces[i]);
      i++;
      continue;
    }
    html += `<mark class="${SEARCH_MATCH_MARK_CLASS}">`;
    while (i < pieces.length && pieces[i].markGroup === group) {
      html += renderPiece(pieces[i]);
      i++;
    }
    html += '</mark>';
  }
  return html;
}

/**
 * Inserts `<mark class="search-match-highlight">` into already-colorized
 * line HTML at the given UTF-16 match ranges, splitting whichever token
 * span(s) a match falls inside so each half keeps its own `mtkN` class. A
 * match that spans two spans gets ONE mark wrapping pieces of both — not two
 * adjacent marks, which would show a visible seam where `.search-match-
 * highlight`'s `border-radius` rounds each one independently.
 *
 * Ranges are UTF-16 offsets into the concatenation of `html`'s text nodes in
 * document order — the same coordinate space `offsetWithinLine` in
 * `caret-offset.ts` sums over the live DOM. For colorized Monaco output that
 * concatenation reproduces the original source line, with one caveat this
 * function inherits rather than fixes: Monaco's non-whitespace-rendering
 * path expands each source TAB into multiple `&nbsp;` characters, so offsets
 * on a line containing a tab before/within a match can land wrong by the
 * same amount `offsetFromPoint`'s caret walk already gets wrong today.
 *
 * Ranges are normalized with the exact policy `splitByMatches` uses (clamp,
 * drop zero-width/out-of-range, drop overlaps) so the two renderers never
 * disagree about which ranges count. When nothing survives normalization the
 * input HTML is returned unchanged.
 */
export function insertMatchMarks(html: string, ranges: MatchRange[]): string {
  const tree = parseHtml(html);
  const runs: Run[] = [];
  flatten(tree, [], runs, { offset: 0 });
  const total = runs.reduce((sum, run) => sum + run.text.length, 0);

  const normalized = normalizeRanges(ranges, total);
  if (normalized.length === 0) return html;

  const pieces = splitRuns(runs, normalized);
  return serialize(pieces);
}
