// ── Lightweight syntactic C# scanner ────────────────────────────────────────
//
// This is the shared building block for EVERY Unity analyzer rule. It is NOT a
// real parser — it strips strings/comments, then uses brace-depth tracking plus
// targeted regular expressions to extract the coarse structure rules care about
// (classes, methods, fields, usings). It must be resilient: malformed/partial
// C# never throws — worst case it returns fewer or slightly-off spans.
//
// Offsets are 0-based string indices into the ORIGINAL text. A `code` view (the
// text with comments/strings blanked to spaces, preserving offsets/length) is
// provided so rules can pattern-match without matching inside literals.

export interface SourceSpan {
  /** 0-based inclusive start offset into the original text. */
  start: number;
  /** 0-based exclusive end offset into the original text. */
  end: number;
}

export interface ParamInfo {
  /** Normalised type text (e.g. `Collider`, `int`, `Vector3`). */
  type: string;
  /** Parameter identifier (best-effort; may be empty). */
  name: string;
}

export interface MethodDecl {
  name: string;
  /** Lowercased modifier set: public/private/protected/internal/static/… */
  modifiers: string[];
  isStatic: boolean;
  returnType: string;
  params: ParamInfo[];
  /** Offset of the first character of the method name. */
  nameOffset: number;
  /** Span of the whole declaration head (modifiers..closing paren). */
  headSpan: SourceSpan;
  /**
   * Span of the body INCLUDING the braces, or null for an abstract/interface
   * method or an expression-bodied member we couldn't brace-match.
   */
  bodySpan: SourceSpan | null;
}

export interface FieldDecl {
  name: string;
  type: string;
  modifiers: string[];
  /** Attribute names attached to the field, e.g. `SerializeField`. */
  attributes: string[];
  /** Offset of the field identifier. */
  nameOffset: number;
  /** Span of the whole declaration line(s) (start of modifiers..trailing ;). */
  declSpan: SourceSpan;
  /** Indentation (leading whitespace) of the declaration's line. */
  indent: string;
}

export interface ClassDecl {
  name: string;
  /** Raw base-type list tokens (interfaces + base class), e.g. `["MonoBehaviour"]`. */
  baseTypes: string[];
  /** Span of the class body including braces. */
  bodySpan: SourceSpan | null;
  nameOffset: number;
}

export interface UsingDirective {
  name: string;
  /** Offset of the `using` keyword. */
  offset: number;
  /** Offset just past the terminating `;` (insertion point for a new using). */
  endOffset: number;
}

export interface CSharpScan {
  /** Original, untouched source. */
  text: string;
  /** Same length as `text`, with comments + string contents replaced by spaces. */
  code: string;
  usings: UsingDirective[];
  classes: ClassDecl[];
  methods: MethodDecl[];
  fields: FieldDecl[];
  /** Cumulative line-start offsets for offset↔line/col mapping. */
  lineStarts: number[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── String/comment blanking ──────────────────────────────────────────────────

/**
 * Produce a copy of `text` where every comment and the *contents* of every
 * string/char literal are replaced by spaces (newlines preserved), so offsets
 * and length match the original exactly. Rules scan this `code` view to avoid
 * false matches inside literals, while still being able to read the real text
 * (e.g. the literal value) from the original at the same offsets.
 */
function blankStringsAndComments(text: string): string {
  const out = text.split('');
  const n = text.length;
  let i = 0;

  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    }
  };

  while (i < n) {
    const c = text[i];
    const next = i + 1 < n ? text[i + 1] : '';

    // Line comment
    if (c === '/' && next === '/') {
      let j = i + 2;
      while (j < n && text[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    // Block comment
    if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < n && !(text[j] === '*' && text[j + 1] === '/')) j++;
      j = Math.min(n, j + 2);
      blank(i, j);
      i = j;
      continue;
    }
    // Verbatim string  @"..."  ("" escapes a quote)
    if (c === '@' && next === '"') {
      let j = i + 2;
      while (j < n) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      blank(i + 2, j - 1); // keep the @ and quotes positionally harmless
      out[i] = ' ';
      i = j;
      continue;
    }
    // Interpolated string $"..." or $@"..." — blank contents but keep braces
    // out of the way too (we don't analyse interpolation holes).
    if (c === '$' && (next === '"' || (next === '@' && text[i + 2] === '"'))) {
      const verbatim = next === '@';
      let j = i + (verbatim ? 3 : 2);
      while (j < n) {
        const ch = text[j];
        if (!verbatim && ch === '\\') {
          j += 2;
          continue;
        }
        if (ch === '"') {
          if (verbatim && text[j + 1] === '"') {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        if (!verbatim && ch === '\n') break; // unterminated
        j++;
      }
      blank(i, j);
      i = j;
      continue;
    }
    // Regular string "..."
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === '"') {
          j++;
          break;
        }
        if (text[j] === '\n') break; // unterminated — bail
        j++;
      }
      blank(i + 1, j - 1);
      i = j;
      continue;
    }
    // Char literal '...'
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === "'") {
          j++;
          break;
        }
        if (text[j] === '\n') break;
        j++;
      }
      blank(i + 1, j - 1);
      i = j;
      continue;
    }
    i++;
  }

  return out.join('');
}

// ── Offset ↔ line/col mapping ────────────────────────────────────────────────

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

/** Convert a 0-based offset to a 1-based {line, col} (Monaco/diagnostic style). */
export function offsetToLineCol(
  lineStarts: number[],
  offset: number,
): { line: number; col: number } {
  // Binary search for the greatest line-start <= offset.
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, col: offset - lineStarts[lo] + 1 };
}

/** Convert a 1-based {line, col} back to a 0-based offset. */
export function lineColToOffset(
  lineStarts: number[],
  line: number,
  col: number,
): number {
  const idx = Math.min(Math.max(line - 1, 0), lineStarts.length - 1);
  return lineStarts[idx] + Math.max(0, col - 1);
}

/** Leading whitespace of the line containing `offset`. */
function indentAt(text: string, lineStarts: number[], offset: number): string {
  const { line } = offsetToLineCol(lineStarts, offset);
  const start = lineStarts[line - 1];
  let i = start;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  return text.slice(start, i);
}

// ── Brace matching ───────────────────────────────────────────────────────────

/**
 * Given the offset of an opening `{` in the blanked `code`, return the offset of
 * the matching `}` (inclusive). Returns -1 if unbalanced (malformed code).
 */
function matchBrace(code: string, openOffset: number): number {
  let depth = 0;
  for (let i = openOffset; i < code.length; i++) {
    const ch = code[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Offset of the next non-whitespace char at/after `from`, or -1. */
function nextNonWs(code: string, from: number): number {
  let i = from;
  while (i < code.length && /\s/.test(code[i])) i++;
  return i < code.length ? i : -1;
}

// ── Parameter list parsing ───────────────────────────────────────────────────

/** Split a parameter-list body on top-level commas (respecting <> and ()). */
function splitParams(inner: string): string[] {
  const parts: string[] = [];
  let depthAngle = 0;
  let depthParen = 0;
  let depthBracket = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '<') depthAngle++;
    else if (ch === '>') depthAngle = Math.max(0, depthAngle - 1);
    else if (ch === '(') depthParen++;
    else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
    else if (ch === '[') depthBracket++;
    else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
    if (ch === ',' && depthAngle === 0 && depthParen === 0 && depthBracket === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim().length > 0) parts.push(cur);
  return parts;
}

/** Parse a single parameter token like `[In] ref Collision other = null`. */
function parseParam(raw: string): ParamInfo | null {
  let s = raw.trim();
  if (!s) return null;
  // Strip attributes [...]
  s = s.replace(/\[[^\]]*\]/g, ' ').trim();
  // Strip a default-value clause.
  const eq = s.indexOf('=');
  if (eq >= 0) s = s.slice(0, eq).trim();
  // Strip leading parameter modifiers.
  s = s.replace(/^(this\s+|params\s+|ref\s+|out\s+|in\s+|readonly\s+|scoped\s+)+/i, '').trim();
  if (!s) return null;
  // The identifier is the last whitespace-separated token; the type is the rest.
  const tokens = s.split(/\s+/);
  if (tokens.length === 1) {
    return { type: tokens[0], name: '' };
  }
  const name = tokens[tokens.length - 1];
  const type = tokens.slice(0, -1).join(' ');
  return { type, name };
}

function parseParamList(inner: string): ParamInfo[] {
  return splitParams(inner)
    .map(parseParam)
    .filter((p): p is ParamInfo => p !== null);
}

// ── Attribute collection (for fields) ────────────────────────────────────────

const ATTR_NAMES_RE = /\[\s*([^\]]*)\]/g;

/**
 * Walk backwards from a declaration start, collecting attribute names that sit
 * immediately above it (possibly several `[...]` blocks across lines). Reads
 * the blanked `code` so strings inside attribute args are ignored.
 */
function collectLeadingAttributes(code: string, declStart: number): {
  names: string[];
  attrStart: number;
} {
  const names: string[] = [];
  let cursor = declStart;
  // Skip whitespace immediately preceding.
  let i = cursor - 1;
  for (;;) {
    while (i >= 0 && /\s/.test(code[i])) i--;
    if (i < 0 || code[i] !== ']') break;
    // Find the matching '[' for this ']'.
    let depth = 0;
    let j = i;
    for (; j >= 0; j--) {
      if (code[j] === ']') depth++;
      else if (code[j] === '[') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (j < 0) break;
    const block = code.slice(j, i + 1);
    for (const m of block.matchAll(ATTR_NAMES_RE)) {
      const body = m[1];
      // Split multiple attributes in one block: [A, B(...)]
      for (const piece of splitParams(body)) {
        const nameMatch = piece.trim().match(/^([A-Za-z_][A-Za-z0-9_.]*)/);
        if (nameMatch) {
          // Normalise `UnityEngine.SerializeField` → `SerializeField`.
          const parts = nameMatch[1].split('.');
          names.push(parts[parts.length - 1]);
        }
      }
    }
    cursor = j;
    i = j - 1;
  }
  return { names: names.reverse(), attrStart: cursor };
}

// ── Main scan ────────────────────────────────────────────────────────────────

const USING_RE = /(^|\n)\s*using\s+(?:static\s+)?([A-Za-z_][\w.]*(?:\s*=\s*[A-Za-z_][\w.<>,\s]*)?)\s*;/g;
const CLASS_RE = /\b(?:class|struct)\s+([A-Za-z_]\w*)(?:\s*<[^>{]*>)?\s*(?::\s*([^{]+?))?\s*\{/g;

// A method declaration head: optional modifiers, return type, name, (params).
// We deliberately keep this permissive; downstream rules add their own checks.
const METHOD_RE =
  /(?:^|[;{}\s])((?:(?:public|private|protected|internal|static|virtual|override|sealed|async|extern|new|unsafe|partial)\s+)*)([A-Za-z_][\w.<>,\s[\]?]*?)\s+([A-Za-z_]\w*)\s*\(([^()]*)\)\s*(?=\{|=>|;|where\b)/g;

const FIELD_RE =
  /(?:^|[;{}\s])((?:(?:public|private|protected|internal|static|readonly|const|volatile|new)\s+)*)([A-Za-z_][\w.<>,\s[\]?]*?)\s+([A-Za-z_]\w*)\s*(?:=\s*[^;]*)?;/g;

const MODIFIER_WORDS = new Set([
  'public', 'private', 'protected', 'internal', 'static', 'virtual',
  'override', 'sealed', 'async', 'extern', 'new', 'unsafe', 'partial',
  'readonly', 'const', 'volatile', 'abstract',
]);

function parseModifiers(raw: string): string[] {
  return raw
    .trim()
    .split(/\s+/)
    .filter((w) => MODIFIER_WORDS.has(w));
}

/**
 * Scan a C# document string into a coarse structural model. Never throws.
 */
export function scanCSharp(text: string): CSharpScan {
  const lineStarts = computeLineStarts(text);
  let code: string;
  try {
    code = blankStringsAndComments(text);
  } catch {
    code = text; // extremely defensive — should never happen
  }

  const scan: CSharpScan = {
    text,
    code,
    usings: [],
    classes: [],
    methods: [],
    fields: [],
    lineStarts,
  };

  try {
    // Usings
    USING_RE.lastIndex = 0;
    for (const m of code.matchAll(USING_RE)) {
      const lead = m[1] ? m[1].length : 0;
      const offset = (m.index ?? 0) + lead;
      const name = m[2].replace(/\s+/g, ' ').trim();
      scan.usings.push({
        name,
        offset,
        endOffset: (m.index ?? 0) + m[0].length,
      });
    }

    // Classes / structs
    CLASS_RE.lastIndex = 0;
    for (const m of code.matchAll(CLASS_RE)) {
      const name = m[1];
      const nameOffset = (m.index ?? 0) + m[0].indexOf(name);
      const baseRaw = m[2] ?? '';
      const baseTypes = baseRaw
        .split(',')
        .map((t) => t.trim())
        // Drop generic args / constraints noise: keep the leading identifier.
        .map((t) => t.replace(/<.*$/, '').trim())
        .filter(Boolean);
      const braceOffset = (m.index ?? 0) + m[0].length - 1; // position of '{'
      const close = matchBrace(code, braceOffset);
      scan.classes.push({
        name,
        baseTypes,
        nameOffset,
        bodySpan: close >= 0 ? { start: braceOffset, end: close + 1 } : null,
      });
    }

    // Methods
    METHOD_RE.lastIndex = 0;
    for (const m of code.matchAll(METHOD_RE)) {
      const modifiersRaw = m[1] ?? '';
      let returnType = (m[2] ?? '').replace(/\s+/g, ' ').trim();
      const name = m[3];
      const paramsRaw = m[4] ?? '';
      // Guard against matching control-flow keywords as "return types".
      if (/\b(if|for|foreach|while|switch|catch|using|lock|fixed|return)\b/.test(returnType)) {
        continue;
      }
      // The match starts on a delimiter char; locate the real name offset by
      // searching for `name` immediately followed by the param-list `(`.
      const matchStart = m.index ?? 0;
      const nameParenIdx = m[0].search(
        new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`),
      );
      const nameOffset =
        nameParenIdx >= 0 ? matchStart + nameParenIdx : matchStart;
      const headStart = matchStart + (/[;{}\s]/.test(m[0][0]) ? 1 : 0);
      const headEnd = matchStart + m[0].length;

      // Find the body: next non-ws after the head should be '{' (or '=>'/';').
      const afterHead = nextNonWs(code, headEnd);
      let bodySpan: SourceSpan | null = null;
      if (afterHead >= 0 && code[afterHead] === '{') {
        const close = matchBrace(code, afterHead);
        if (close >= 0) bodySpan = { start: afterHead, end: close + 1 };
      } else if (afterHead >= 0 && code[afterHead] === 'w') {
        // `where` constraint(s) before the body — skip to the next '{'.
        const braceIdx = code.indexOf('{', afterHead);
        if (braceIdx >= 0) {
          const close = matchBrace(code, braceIdx);
          if (close >= 0) bodySpan = { start: braceIdx, end: close + 1 };
        }
      }

      scan.methods.push({
        name,
        modifiers: parseModifiers(modifiersRaw),
        isStatic: /\bstatic\b/.test(modifiersRaw),
        returnType,
        params: parseParamList(paramsRaw),
        nameOffset,
        headSpan: { start: headStart, end: headEnd },
        bodySpan,
      });
    }

    // Fields
    FIELD_RE.lastIndex = 0;
    for (const m of code.matchAll(FIELD_RE)) {
      const modifiersRaw = m[1] ?? '';
      const type = (m[2] ?? '').replace(/\s+/g, ' ').trim();
      const name = m[3];
      // Skip obvious non-fields: local-ish keywords or method-looking matches.
      if (/\b(return|var|new|if|for|while|using|namespace|class|struct|enum|interface)\b/.test(type)) {
        continue;
      }
      // Reject when the "type" still looks like a parenthesised expression.
      if (type.includes('(') || type.includes(')')) continue;

      const matchStart = m.index ?? 0;
      const declContentStart = matchStart + (/[;{}\s]/.test(m[0][0]) ? 1 : 0);
      // Anchor the name where it's followed by `;` or `=` (the declared field),
      // so we don't land on an identical token inside the type.
      const nameTermIdx = m[0].search(new RegExp(`\\b${escapeRegExp(name)}\\s*(?:=|;)`));
      const nameOffset = nameTermIdx >= 0 ? matchStart + nameTermIdx : matchStart;
      const { names: attributes, attrStart } = collectLeadingAttributes(code, declContentStart);

      scan.fields.push({
        name,
        type,
        modifiers: parseModifiers(modifiersRaw),
        attributes,
        nameOffset: nameOffset >= 0 ? nameOffset : matchStart,
        declSpan: { start: attrStart, end: matchStart + m[0].length },
        indent: indentAt(text, lineStarts, declContentStart),
      });
    }
  } catch (err) {
    // Never let a malformed document crash the analyzer engine.
    console.warn('[unity-analyzers] scanCSharp partial failure (continuing):', err);
  }

  return scan;
}

// ── Span helpers shared by rules ─────────────────────────────────────────────

/** True if `offset` falls inside `[span.start, span.end)`. */
export function offsetInSpan(span: SourceSpan, offset: number): boolean {
  return offset >= span.start && offset < span.end;
}

/** The method whose body contains `offset`, or undefined. */
export function methodContaining(scan: CSharpScan, offset: number): MethodDecl | undefined {
  let best: MethodDecl | undefined;
  for (const meth of scan.methods) {
    if (meth.bodySpan && offsetInSpan(meth.bodySpan, offset)) {
      // Prefer the innermost (smallest) body when nested (local functions).
      if (!best || !best.bodySpan ||
          (meth.bodySpan.end - meth.bodySpan.start) < (best.bodySpan.end - best.bodySpan.start)) {
        best = meth;
      }
    }
  }
  return best;
}

/** The class whose body contains `offset`, or undefined. */
export function classContaining(scan: CSharpScan, offset: number): ClassDecl | undefined {
  let best: ClassDecl | undefined;
  for (const cls of scan.classes) {
    if (cls.bodySpan && offsetInSpan(cls.bodySpan, offset)) {
      if (!best || !best.bodySpan ||
          (cls.bodySpan.end - cls.bodySpan.start) < (best.bodySpan.end - best.bodySpan.start)) {
        best = cls;
      }
    }
  }
  return best;
}
