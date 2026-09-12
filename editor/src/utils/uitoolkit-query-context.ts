// "Is the caret inside a UI Toolkit query string, and what is it asking for?"
//
// One question, three consumers: completion (offer element names), hover
// (describe the element) and go-to-definition (jump to the UXML line). Keeping
// it in one pure function is what stops those three drifting into three subtly
// different ideas of what counts as a query.
//
// Deliberately line-scoped. A C# string literal can span lines only as a
// verbatim/raw string, and a `Q()` argument is never written that way -- so
// working within the line keeps this cheap and keeps an unterminated quote
// (which is the NORMAL state while someone is typing) from swallowing the rest
// of the file.
//
// A leaf module: no imports, so it loads under Bun's DOM-less test runtime.

export type QuerySlot = 'name' | 'className';

export interface QueryContext {
  /** Which argument the caret is in. */
  slot: QuerySlot;
  /** Literal contents, excluding the quotes. Partial while typing. */
  value: string;
  /** Offset of the first character inside the quotes. */
  start: number;
  /** Offset just past the last character inside the quotes. */
  end: number;
  /**
   * The generic argument of `Q<T>(...)`, namespace stripped, or null for a
   * non-generic `Q(...)`. Completion ranks matching element types first, and
   * the type-mismatch diagnostic needs it.
   */
  typeArg: string | null;
}

/** Calls whose string argument is a USS class rather than an element name. */
const CLASS_CALLS =
  'AddToClassList|RemoveFromClassList|ToggleInClassList|EnableInClassList|ClassListContains';

const CLASS_CALL_RE = new RegExp(`\\.\\s*(?:${CLASS_CALLS})\\s*\\(\\s*$`);
const NAMED_CLASS_RE = /\bclassName\s*:\s*$/;
const NAMED_NAME_RE = /\bname\s*:\s*$/;
/** The `.Q<T>(` / `.Query(` whose argument list the caret sits in. */
const QUERY_CALL_RE = /\.\s*(?:Q|Query)\s*(?:<([^<>()]*)>)?\s*\(([^()]*)$/;

interface Literal {
  start: number;
  end: number;
  /** Offset of the opening quote. */
  quote: number;
}

/** The double-quoted literal containing `col`, tolerating an unterminated one. */
function literalAt(line: string, col: number): Literal | null {
  let inString = false;
  let openedAt = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '"') {
        inString = false;
        // `col > openedAt` puts the caret past the opening quote; `col <= i`
        // lets it sit on the closing one, which is where it lands after typing.
        if (col > openedAt && col <= i) return { start: openedAt + 1, end: i, quote: openedAt };
      }
    } else if (ch === '"') {
      inString = true;
      openedAt = i;
    }
  }
  // Unterminated -- the normal state mid-keystroke.
  if (inString && col > openedAt) return { start: openedAt + 1, end: line.length, quote: openedAt };
  return null;
}

/** True when `col` sits after a real `//`, not one inside a string. */
function inLineComment(line: string, col: number): boolean {
  const at = line.indexOf('//');
  if (at === -1 || at >= col) return false;
  let quotes = 0;
  for (let i = 0; i < at; i++) {
    if (line[i] === '\\') {
      i++;
      continue;
    }
    if (line[i] === '"') quotes++;
  }
  return quotes % 2 === 0;
}

/** Commas at paren depth 0 -- i.e. which positional argument we are in. */
function positionalIndex(argsSoFar: string): number {
  let depth = 0;
  let index = 0;
  let inString = false;
  for (let i = 0; i < argsSoFar.length; i++) {
    const ch = argsSoFar[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '(' || ch === '<' || ch === '[') depth++;
    else if (ch === ')' || ch === '>' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) index++;
  }
  return index;
}

/** `UnityEngine.UIElements.Button` -> `Button`. */
function bareType(generic: string | undefined): string | null {
  if (!generic) return null;
  const trimmed = generic.trim();
  if (trimmed === '') return null;
  const dot = trimmed.lastIndexOf('.');
  return dot === -1 ? trimmed : trimmed.slice(dot + 1);
}

/**
 * Classify the string literal at `offset`, or null when it is not a UI Toolkit
 * query argument.
 */
export function queryContextAt(text: string, offset: number): QueryContext | null {
  const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  let lineEnd = text.indexOf('\n', offset);
  if (lineEnd === -1) lineEnd = text.length;
  const line = text.slice(lineStart, lineEnd);
  const col = offset - lineStart;

  if (inLineComment(line, col)) return null;

  const literal = literalAt(line, col);
  if (!literal) return null;

  const before = line.slice(0, literal.quote);
  const common = {
    value: line.slice(literal.start, literal.end),
    start: lineStart + literal.start,
    end: lineStart + literal.end,
  };

  // `AddToClassList("...")` and friends -- a class, and no generic to read.
  if (CLASS_CALL_RE.test(before)) return { slot: 'className', typeArg: null, ...common };

  const call = QUERY_CALL_RE.exec(before);
  if (!call) return null;

  const typeArg = bareType(call[1]);
  const argsSoFar = call[2];

  // A named argument settles it outright, whatever position it sits in.
  if (NAMED_CLASS_RE.test(argsSoFar)) return { slot: 'className', typeArg, ...common };
  if (NAMED_NAME_RE.test(argsSoFar)) return { slot: 'name', typeArg, ...common };

  // Positional: `Q(name, className)`. Anything past the second argument is not
  // a thing we can help with.
  const index = positionalIndex(argsSoFar);
  if (index === 0) return { slot: 'name', typeArg, ...common };
  if (index === 1) return { slot: 'className', typeArg, ...common };
  return null;
}
