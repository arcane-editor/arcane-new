import type { Monaco } from '@monaco-editor/react';
import type { languages } from 'monaco-editor';

/**
 * Monaco language id for `.env` files. Kept in sync with
 * `utils/language-detect.ts`, which decides which files get it.
 */
export const DOTENV_LANG_ID = 'dotenv';

/**
 * The load-bearing half is `comments.lineComment`.
 *
 * Monaco's Cmd+/ (`editor.action.commentLine`) looks up the language's comment
 * configuration and bails out silently when there isn't one — its own source
 * says "Mode does not support line comments". Since `.env` previously resolved
 * to plaintext, which registers no configuration at all, Cmd+/ appeared broken
 * in exactly those files.
 */
const dotenvLanguageConfig: languages.LanguageConfiguration = {
  comments: { lineComment: '#' },
  brackets: [['{', '}']],
  autoClosingPairs: [
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  surroundingPairs: [
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
};

/**
 * Deliberately small. A .env file is `KEY=value` plus comments — the value is
 * free-form text, so tokenizing it beyond quotes and `${...}` interpolation
 * invents rules the format doesn't have.
 */
const dotenvLanguage: languages.IMonarchLanguage = {
  defaultToken: '',
  tokenizer: {
    root: [
      [/^\s*#.*$/, 'comment'],
      // `export FOO=bar` is valid in most .env loaders.
      [/^\s*(export)(\s+)/, ['keyword', '']],
      // KEY=  — the '=' hands off to the value state so the rest of the line
      // isn't re-scanned as more keys.
      [/([A-Za-z_][A-Za-z0-9_.]*)(\s*)(=)/, ['variable.name', '', 'operator'], '@value'],
      [/.*$/, ''],
    ],
    value: [
      [/#.*$/, 'comment', '@pop'],
      [/"/, 'string', '@dquote'],
      [/'/, 'string', '@squote'],
      [/\$\{[^}]*\}/, 'variable'],
      [/$/, '', '@pop'],
      [/[^#'"$]+/, 'string'],
      [/./, 'string'],
    ],
    dquote: [
      [/\$\{[^}]*\}/, 'variable'],
      [/[^"$]+/, 'string'],
      [/"/, 'string', '@pop'],
      [/./, 'string'],
    ],
    squote: [
      // Single quotes don't interpolate in any .env loader.
      [/[^']+/, 'string'],
      [/'/, 'string', '@pop'],
    ],
  },
};

let registered = false;

/**
 * Registers the `.env` language. Idempotent — Monaco language registration is
 * process-global, and this runs from the editor's `beforeMount`, which fires
 * per editor instance.
 *
 * Matching is by filename rather than extension (see `language-detect.ts`), so
 * no `extensions` are declared here: `EditorPanel` passes the resolved language
 * id explicitly.
 */
export function registerDotEnvLanguage(monaco: Monaco): void {
  if (registered) return;
  registered = true;

  monaco.languages.register({
    id: DOTENV_LANG_ID,
    aliases: ['DotEnv', 'dotenv'],
    filenames: ['.env'],
    filenamePatterns: ['.env.*', 'env.example', 'env.sample', 'env.template'],
  });
  monaco.languages.setMonarchTokensProvider(DOTENV_LANG_ID, dotenvLanguage);
  monaco.languages.setLanguageConfiguration(DOTENV_LANG_ID, dotenvLanguageConfig);
}
