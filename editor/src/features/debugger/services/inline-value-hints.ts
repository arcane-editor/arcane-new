/**
 * Which variable values belong on which lines.
 *
 * A leaf module on purpose: no store, no Monaco, no Tauri. Importing the debug
 * store here would drag `@tauri-apps/api` into every test that touches this
 * logic, and the matching rules — whole identifiers, not substrings; code, not
 * comments — are exactly the part worth testing without a debug session.
 */

/** The minimum a value needs to be placed on a line. */
export interface NamedValue {
  name: string;
  value: string;
}

/** How far above and below the stopped line to annotate. */
const WINDOW = 60;

/** How many variables to show on one line before it becomes noise. */
const MAX_PER_LINE = 3;

/** Longest value rendered inline; the rest lives in the Variables pane. */
const MAX_VALUE_LENGTH = 40;

export interface InlineHint {
  line: number;
  text: string;
}

/**
 * Work out which variables to show on which lines.
 *
 * Pure, so the matching rules are testable without Monaco or a debug session.
 * `lines` is the file's text, 0-indexed; `stoppedLine` is 1-based.
 */
export function inlineHints(
  lines: string[],
  variables: NamedValue[],
  stoppedLine: number,
): InlineHint[] {
  if (variables.length === 0 || stoppedLine < 1) return [];

  const from = Math.max(1, stoppedLine - WINDOW);
  const to = Math.min(lines.length, stoppedLine + WINDOW);
  const hints: InlineHint[] = [];

  for (let line = from; line <= to; line++) {
    const text = lines[line - 1];
    if (!text) continue;
    // Code only: a variable named in a comment or a string is not a variable
    // being used, and annotating it is noise at best and wrong at worst.
    const code = stripCommentsAndStrings(text);
    if (!code.trim()) continue;

    const shown: string[] = [];
    for (const variable of variables) {
      if (shown.length >= MAX_PER_LINE) break;
      if (!mentions(code, variable.name)) continue;
      shown.push(`${variable.name}: ${truncate(variable.value)}`);
    }
    if (shown.length > 0) {
      hints.push({ line, text: shown.join('  ') });
    }
  }

  return hints;
}

/** Whether `code` uses `name` as a whole identifier. */
function mentions(code: string, name: string): boolean {
  if (!name) return false;
  // Not a regex built from the name: a variable called `a.b` or `$x` would
  // otherwise compile into a pattern that matches far too much.
  let index = code.indexOf(name);
  while (index !== -1) {
    const before = index === 0 ? '' : code[index - 1];
    const after = code[index + name.length] ?? '';
    if (!isIdentifierChar(before) && !isIdentifierChar(after)) return true;
    index = code.indexOf(name, index + 1);
  }
  return false;
}

function isIdentifierChar(c: string): boolean {
  return c !== '' && /[A-Za-z0-9_$]/.test(c);
}

/**
 * Blank out string literals and comments, keeping the line's length so column
 * positions still line up.
 */
export function stripCommentsAndStrings(text: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      out += ' ';
      if (c === '\\') {
        // Skip the escaped character so a `\"` does not end the string.
        out += ' ';
        i++;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += ' ';
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      return out + ' '.repeat(text.length - i);
    }
    out += c;
  }
  return out;
}

function truncate(value: string): string {
  const single = value.replace(/\s+/g, ' ').trim();
  return single.length > MAX_VALUE_LENGTH
    ? `${single.slice(0, MAX_VALUE_LENGTH - 1)}…`
    : single;
}
