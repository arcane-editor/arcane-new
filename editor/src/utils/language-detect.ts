/**
 * Single source of truth for language identification across the IDE.
 *
 * Replaces the duplicated extension maps that previously lived in
 * EditorPanel, StatusBar, and the workspace store.
 */

export interface LangInfo {
  /** Monaco language id — drives syntax highlighting. */
  monacoId: string;
  /** Pretty name shown in the status bar. */
  displayName: string;
  /**
   * `languageId` field for LSP `textDocument/didOpen`. Undefined when no LSP
   * server handles this language.
   */
  lspLanguageId?: string;
  /**
   * Registry key for which backend LSP server handles this file. Multiple
   * `lspLanguageId`s can share a server (e.g. `typescript`, `javascript`,
   * `typescriptreact`, `javascriptreact` all map to the `typescript` server).
   */
  lspServerKey?: LspServerKey;
}

export type LspServerKey = 'csharp' | 'python' | 'typescript';

/**
 * The complete set of LSP server keys understood by the backend. Used by
 * `lspManager` and the Rust binary resolver.
 */
export const KNOWN_LSP_SERVERS = ['csharp', 'python', 'typescript'] as const;

/**
 * Monaco language ids that get LSP-backed providers (completion, hover, …)
 * registered on them. JavaScript and TypeScript both qualify because the
 * single `typescript-language-server` process serves both.
 */
export const LSP_BACKED_MONACO_LANGUAGES = [
  'csharp',
  'python',
  'typescript',
  'javascript',
] as const;

interface LangSpec extends LangInfo {
  extensions: readonly string[];
}

/**
 * Languages matched on the BASENAME rather than an extension.
 *
 * Dotfiles don't really have extensions: `.env`'s last dot-segment is "env",
 * and `.env.local`'s is "local" — neither is something you'd register as an
 * extension without hijacking unrelated files. So they're matched by name.
 *
 * This is what makes Cmd+/ work in them, incidentally: Monaco's comment action
 * silently does nothing unless the file's language declares a `lineComment`
 * ("Mode does not support line comments"), and plaintext declares none.
 */
const BY_FILENAME: ReadonlyArray<{ test: (basename: string) => boolean; info: LangInfo }> = [
  {
    // `.env`, `.env.local`, `.env.production.local`, and the `env.example`
    // convention — but NOT `.envrc` (that's direnv, a shell script) and not
    // `env.json`/`environment.ts`, which have real extensions of their own.
    test: (base) => /^\.env(\.[^.]+)*$/.test(base) || /^env\.(example|sample|template)$/.test(base),
    info: { monacoId: 'dotenv', displayName: 'DotEnv' },
  },
];

const SPECS: readonly LangSpec[] = [
  // ── Languages with LSP support ──────────────────────────────────
  {
    extensions: ['cs'],
    monacoId: 'csharp',
    displayName: 'C#',
    lspLanguageId: 'csharp',
    lspServerKey: 'csharp',
  },
  {
    extensions: ['py'],
    monacoId: 'python',
    displayName: 'Python',
    lspLanguageId: 'python',
    lspServerKey: 'python',
  },
  {
    extensions: ['ts', 'mts', 'cts'],
    monacoId: 'typescript',
    displayName: 'TypeScript',
    lspLanguageId: 'typescript',
    lspServerKey: 'typescript',
  },
  {
    extensions: ['tsx'],
    monacoId: 'typescript',
    displayName: 'TypeScript JSX',
    lspLanguageId: 'typescriptreact',
    lspServerKey: 'typescript',
  },
  {
    extensions: ['js', 'mjs', 'cjs'],
    monacoId: 'javascript',
    displayName: 'JavaScript',
    lspLanguageId: 'javascript',
    lspServerKey: 'typescript',
  },
  {
    extensions: ['jsx'],
    monacoId: 'javascript',
    displayName: 'JavaScript JSX',
    lspLanguageId: 'javascriptreact',
    lspServerKey: 'typescript',
  },

  // ── Languages without LSP support — Monaco syntax only ─────────
  { extensions: ['json'], monacoId: 'json', displayName: 'JSON' },
  { extensions: ['html'], monacoId: 'html', displayName: 'HTML' },
  { extensions: ['css'], monacoId: 'css', displayName: 'CSS' },
  { extensions: ['scss'], monacoId: 'scss', displayName: 'SCSS' },
  // Unity UI Toolkit — reuse Monaco's css/xml highlighting; UI-Toolkit-specific
  // completions are layered on by the `uitoolkit` feature (F-3.2 T7.3).
  { extensions: ['uss'], monacoId: 'css', displayName: 'USS (UI Toolkit)' },
  { extensions: ['uxml'], monacoId: 'xml', displayName: 'UXML (UI Toolkit)' },
  { extensions: ['md'], monacoId: 'markdown', displayName: 'Markdown' },
  { extensions: ['rs'], monacoId: 'rust', displayName: 'Rust' },
  { extensions: ['toml'], monacoId: 'toml', displayName: 'TOML' },
  { extensions: ['yaml', 'yml'], monacoId: 'yaml', displayName: 'YAML' },
  { extensions: ['sh', 'bash'], monacoId: 'shell', displayName: 'Shell' },
  { extensions: ['go'], monacoId: 'go', displayName: 'Go' },
  { extensions: ['java'], monacoId: 'java', displayName: 'Java' },
  { extensions: ['c', 'h'], monacoId: 'c', displayName: 'C' },
  { extensions: ['cpp', 'hpp', 'cc'], monacoId: 'cpp', displayName: 'C++' },
  { extensions: ['rb'], monacoId: 'ruby', displayName: 'Ruby' },
  { extensions: ['php'], monacoId: 'php', displayName: 'PHP' },
  { extensions: ['sql'], monacoId: 'sql', displayName: 'SQL' },
  { extensions: ['xml', 'svg'], monacoId: 'xml', displayName: 'XML' },

  // ── Shader languages (registered by features/shader-languages) ──
  { extensions: ['shader'], monacoId: 'shaderlab', displayName: 'ShaderLab' },
  { extensions: ['hlsl', 'cginc', 'compute'], monacoId: 'hlsl', displayName: 'HLSL' },
  { extensions: ['glsl'], monacoId: 'glsl', displayName: 'GLSL' },
];

const BY_EXT: Map<string, LangSpec> = (() => {
  const m = new Map<string, LangSpec>();
  for (const spec of SPECS) {
    for (const ext of spec.extensions) m.set(ext, spec);
  }
  return m;
})();

const PLAINTEXT: LangInfo = Object.freeze({
  monacoId: 'plaintext',
  displayName: 'Plain Text',
});

function specToInfo(spec: LangSpec): LangInfo {
  return {
    monacoId: spec.monacoId,
    displayName: spec.displayName,
    lspLanguageId: spec.lspLanguageId,
    lspServerKey: spec.lspServerKey,
  };
}

/**
 * Resolve a filename's language. Accepts a bare name or a full path.
 * Returns `plaintext` when nothing matches.
 */
export function detectLanguage(filename: string): LangInfo {
  // Basename first: dotfiles are identified by name, and an extension lookup on
  // one would either miss (`.env` -> "env") or, worse, match the wrong spec.
  const basename = filename.split('/').pop()?.toLowerCase() ?? '';
  for (const entry of BY_FILENAME) {
    if (entry.test(basename)) return entry.info;
  }

  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const spec = BY_EXT.get(ext);
  return spec ? specToInfo(spec) : PLAINTEXT;
}

/** Convenience: just the Monaco language id. */
export function getMonacoLanguageId(filename: string): string {
  return detectLanguage(filename).monacoId;
}

/** True iff this file's language has an LSP server we can run. */
export function hasLspSupport(filename: string): boolean {
  return detectLanguage(filename).lspServerKey !== undefined;
}
