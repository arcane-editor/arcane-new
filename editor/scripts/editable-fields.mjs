/**
 * Finds text fields that still accept the OS's dictionary help.
 *
 * macOS underlines "GetComponnet" in a filter box and offers to correct it,
 * because a WebKit text field opts INTO spell checking and autocorrection by
 * default. Every identifier, path, glob and regex a user types into this app
 * is a false positive, and an autocorrected search silently returns the wrong
 * results — the user sees a query they did not write and no error.
 *
 * Twenty-two of thirty-four fields had the attributes and twelve did not,
 * because each one is written by hand. This is the check that makes the
 * thirty-fifth impossible to forget.
 *
 * Pure (takes file *contents*, not paths) so it is unit-testable without a
 * fixture tree; `check-no-autocorrect.mjs` is the thin runner.
 */

/** Input types that hold no free text, so the OS never offers to help. */
const NON_TEXT_TYPES = ['checkbox', 'radio', 'range', 'color', 'file', 'number'];

/** What a text field must state. `spellCheck` kills the underline and its
 *  suggestion menu; `autoCorrect` kills silent substitution. The other two are
 *  required with them so every field reads the same way. */
const REQUIRED = ['spellCheck', 'autoCorrect', 'autoComplete', 'autoCapitalize'];

/**
 * Strip comments so a `<textarea>` *described* in prose is not mistaken for
 * one that exists. `KeyboardShortcutManager` explains xterm's helper textarea
 * in a comment and was reported as an unguarded field because of it.
 *
 * A block comment must OPEN at a line start, after whitespace, or after `{`
 * (JSX's `{​/* … *​/}`). Matching a bare `/*` anywhere swallows source: this
 * file's own subject, SearchQueryBar, has `placeholder="Assets/**, *.cs"` and
 * `placeholder="**​/Editor/**"` — the first opens a "comment" the second
 * closes, and everything between them, including a whole `<input>`, vanished
 * from the scan. The second filter box was invisible to this check until the
 * glob stopped counting as punctuation.
 */
function stripComments(source) {
  // Blank the content but KEEP the newlines: the reported line number has to
  // match the real file, or the message sends you to the wrong place.
  return source
    .replace(/(^|[\s{])\/\*[\s\S]*?\*\//g, (m, lead) => lead + m.slice(lead.length).replace(/[^\n]/g, ' '))
    .replace(/^(\s*)\/\/.*$/gm, '$1');
}

/**
 * @param {string} name file name, for the message
 * @param {string} source the .tsx contents
 * @returns {{name: string, line: number, tag: string, missing: string[]}[]}
 */
export function findUnguardedFields(name, source) {
  const lines = stripComments(source).split('\n');
  const found = [];

  for (let i = 0; i < lines.length; i++) {
    const tag = lines[i].includes('<input') ? 'input'
      : lines[i].includes('<textarea') ? 'textarea'
        : null;
    if (!tag) continue;

    // Collect the whole JSX tag. A prop like `onChange={(e) => ...}` contains a
    // `>`, so the opening line's `>` is not the end of the tag — scan forward
    // to a line that closes it instead.
    const block = [];
    let j = i;
    for (; j < lines.length && j < i + 40; j++) {
      block.push(lines[j]);
      const trimmed = lines[j].trimEnd();
      if (j > i && (trimmed.endsWith('/>') || trimmed.endsWith('>'))) break;
    }
    const text = block.join('\n');
    const openedAt = i + 1;
    i = j;

    if (tag === 'input' && NON_TEXT_TYPES.some((t) => text.includes(`type="${t}"`))) continue;
    // An escape hatch for a field that genuinely wants prose help.
    if (text.includes('data-allow-autocorrect')) continue;

    const missing = REQUIRED.filter((attr) => !text.includes(attr));
    if (missing.length > 0) found.push({ name, line: openedAt, tag, missing });
  }

  return found;
}

export const REQUIRED_ATTRIBUTES = REQUIRED;
