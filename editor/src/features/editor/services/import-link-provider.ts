import type { Monaco } from '@monaco-editor/react';
import type { editor, languages, Position, Uri as MonacoUri } from 'monaco-editor';
import { invoke } from '@tauri-apps/api/core';
import { useWorkspaceStore } from '../../../stores/workspace';

/**
 * Go-to-definition + clickable-link support for RELATIVE TS/JS import
 * specifiers (`./foo`, `../bar`), for the case where no LSP is attached (or
 * the attached LSP doesn't resolve the specifier) — see the bug report:
 * right-clicking an import path did nothing because no Monaco link provider
 * existed anywhere in the app.
 *
 * Scope (v1, intentionally narrow):
 *   - Only `./` / `../` specifiers. Bare specifiers (npm packages),
 *     tsconfig `paths` aliases, and non-JS targets (json/yaml/css/...) are
 *     out of scope — resolution only ever tries the extensions below.
 *   - Only the `typescript` / `javascript` Monaco language ids (which also
 *     cover .tsx/.jsx — see `utils/language-detect.ts`).
 *
 * Both providers ride the same cross-file navigation path already wired up
 * globally: `registerEditorOpener` (features/lsp/services/providers.ts)
 * consumes the `{ uri, range }` a DefinitionProvider returns and opens the
 * file via the workspace store, using `utils/editor-navigation.ts` to carry
 * the target position across the remount. This mirrors the shader-language
 * `#include` resolver (features/shader-languages/services/include-resolver.ts).
 *
 * Duplicate definitions from the TS LSP (when one is attached and *does*
 * resolve the specifier) are expected and harmless — Monaco merges results
 * from all registered DefinitionProviders into one "Go to Definition" list.
 */

// ── Language scope ──────────────────────────────────────────────────────

const TS_LANG_ID = 'typescript';
const JS_LANG_ID = 'javascript';

// ── extractSpecifiers ───────────────────────────────────────────────────

export interface ExtractedSpecifier {
  spec: string;
  /** 1-based Monaco column of the first character of `spec` (after the quote). */
  startCol: number;
  /** 1-based Monaco column just past the last character of `spec` (before the closing quote). */
  endCol: number;
}

// Each regex's captured groups are always (1) the quote character and (2)
// the specifier content — this lets extractSpecifiers compute columns the
// same way regardless of which form matched.
//
//   from '...' / from "..."      → `import x from '...'`, `export * from '...'`, `import type x from '...'`
//   import('...')                 → dynamic import
//   require('...')                → CommonJS require
//   import '...' (no "from")      → side-effect import
//
// The side-effect regex requires the quote to appear immediately (modulo
// whitespace) after `import`, which is exactly what excludes it from also
// matching `import('...')` (next char is `(`, not a quote) and
// `import Foo from '...'` (next char is an identifier, not a quote).
const SPECIFIER_PATTERNS: RegExp[] = [
  /\bfrom\s*(['"])([^'"]+)\1/g,
  /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
  /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
  /\bimport\s*(['"])([^'"]+)\1/g,
];

export function isRelativeSpecifier(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../');
}

// Real hand-written import/require statements are never remotely this long.
// Minified/bundled JS, though, can pack an entire module onto one line —
// possibly hundreds of thousands of characters. A line-count cap alone (see
// `MAX_SCANNED_LINES` below) doesn't help a *single* pathological line, so
// bail out of scanning it at all rather than running four regexes over it.
const MAX_LINE_LENGTH = 5000;

/**
 * Pure line scanner: finds every relative import/require/dynamic-import
 * specifier on a single line of TS/JS source and its column span. Bare
 * specifiers (npm packages, tsconfig path aliases) are dropped here so
 * callers never have to re-filter.
 */
export function extractSpecifiers(lineText: string): ExtractedSpecifier[] {
  if (lineText.length > MAX_LINE_LENGTH) return [];

  const results: ExtractedSpecifier[] = [];
  const seen = new Set<string>();

  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(lineText)) !== null) {
      const quoteChar = m[1];
      const spec = m[2];
      if (!isRelativeSpecifier(spec)) continue;

      const quoteOffset = m[0].indexOf(quoteChar);
      const specStart0 = m.index + quoteOffset + 1; // 0-based index of spec's first char
      const startCol = specStart0 + 1;
      const endCol = specStart0 + spec.length + 1;

      const key = `${startCol}:${endCol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ spec, startCol, endCol });
    }
  }

  results.sort((a, b) => a.startCol - b.startCol);
  return results;
}

// ── Candidate generation (pure) ─────────────────────────────────────────

const RESOLVABLE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];

/**
 * Ordered list of candidate specifiers to test for a relative import, first
 * match wins: the literal spec, then the spec with each resolvable
 * extension appended, then `<spec>/index.<ext>` for each index extension.
 * Returns `[]` for non-relative (bare / aliased) specifiers — nothing to
 * resolve without a module-resolution algorithm we don't implement (v1).
 */
export function buildCandidateSpecifiers(spec: string): string[] {
  if (!isRelativeSpecifier(spec)) return [];

  const candidates = [spec];
  for (const ext of RESOLVABLE_EXTENSIONS) candidates.push(`${spec}${ext}`);
  for (const indexFile of INDEX_FILES) candidates.push(`${spec}/${indexFile}`);
  return candidates;
}

// ── Path helpers (self-contained; mirrors shader-languages/include-resolver.ts) ──

/** Directory portion of an absolute file path (no trailing slash). */
function dirOf(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx <= 0 ? '' : norm.slice(0, idx);
}

/** Normalise a `/`-separated path containing `.`/`..` segments. */
function normalizePath(p: string): string {
  const isAbs = p.startsWith('/');
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!isAbs) out.push('..');
    } else {
      out.push(seg);
    }
  }
  return (isAbs ? '/' : '') + out.join('/');
}

function modelUriToPath(uri: MonacoUri): string | null {
  if (uri.scheme !== 'file') return null;
  try {
    return decodeURIComponent(uri.path);
  } catch {
    return uri.path;
  }
}

// ── resolveSpecifier (async, cached) ────────────────────────────────────

// Keyed on `${baseDir}|${spec}` → resolved absolute path, or null when no
// candidate exists. Caching a miss is deliberate (avoids re-probing every
// candidate on repeated hovers of the same broken import); the whole cache
// is invalidated on workspace change (below), which is coarse but matches
// this feature's "best-effort, not authoritative" role — the TS LSP (when
// attached) is still the source of truth for anything it can resolve.
const resolveCache = new Map<string, string | null>();

let cacheInvalidationSubscribed = false;

/**
 * Subscribes once (module-wide) to workspace-path changes and clears the
 * resolution cache when the workspace changes. Guarded so repeated calls
 * (e.g. from re-registration) never stack up more than one subscription —
 * the subscription itself is never torn down, but there is at most one for
 * the lifetime of the app, same as the providers it backs.
 */
function ensureCacheInvalidationSubscribed(): void {
  if (cacheInvalidationSubscribed) return;
  cacheInvalidationSubscribed = true;

  let lastWorkspacePath = useWorkspaceStore.getState().workspacePath;
  useWorkspaceStore.subscribe((state) => {
    if (state.workspacePath === lastWorkspacePath) return;
    lastWorkspacePath = state.workspacePath;
    resolveCache.clear();
  });
}

/**
 * Resolve a relative import specifier to an absolute file path by testing
 * candidates (see `buildCandidateSpecifiers`) with the Rust `path_exists`
 * command, first match wins. Returns `null` for bare specifiers or when no
 * candidate exists on disk.
 */
export async function resolveSpecifier(
  currentFilePath: string,
  spec: string,
): Promise<string | null> {
  if (!isRelativeSpecifier(spec)) return null;

  const baseDir = dirOf(currentFilePath);
  if (!baseDir) return null;

  ensureCacheInvalidationSubscribed();

  const cacheKey = `${baseDir}|${spec}`;
  const cached = resolveCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let resolved: string | null = null;
  for (const candidate of buildCandidateSpecifiers(spec)) {
    const absolute = normalizePath(`${baseDir}/${candidate}`);
    try {
      const exists = await invoke<boolean>('path_exists', { path: absolute });
      if (exists) {
        resolved = absolute;
        break;
      }
    } catch {
      // Treat a failed IPC call as "this candidate doesn't exist" and keep
      // trying the rest rather than aborting resolution entirely.
    }
  }

  resolveCache.set(cacheKey, resolved);
  return resolved;
}

// ── Providers ────────────────────────────────────────────────────────────

/** Extra fields threaded through Monaco's `ILink` so `resolveLink` (which
 * only receives the link, not the model) knows what to resolve. */
interface ImportLink extends languages.ILink {
  spec: string;
  filePath: string;
}

const MAX_SCANNED_LINES = 5000;

function createDefinitionProvider(monaco: Monaco): languages.DefinitionProvider {
  return {
    async provideDefinition(model: editor.ITextModel, position: Position) {
      const lineText = model.getLineContent(position.lineNumber);
      const specifier = extractSpecifiers(lineText).find(
        (s) => position.column >= s.startCol && position.column <= s.endCol,
      );
      if (!specifier) return null;

      const currentFilePath = modelUriToPath(model.uri);
      if (!currentFilePath) return null;

      const target = await resolveSpecifier(currentFilePath, specifier.spec);
      if (!target) return null;

      return {
        uri: monaco.Uri.file(target),
        range: {
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: 1,
        },
      };
    },
  };
}

function createLinkProvider(monaco: Monaco): languages.LinkProvider {
  return {
    provideLinks(model: editor.ITextModel) {
      const filePath = modelUriToPath(model.uri);
      if (!filePath) return { links: [] };

      // provideLinks receives the whole model (not just the visible
      // viewport), and Monaco re-invokes it on every edit. Regex-scanning a
      // pathological multi-hundred-thousand-line file on every keystroke is
      // wasted work for a best-effort feature, so cap it — files past this
      // size are exceedingly unlikely to be hand-edited TS/JS source anyway.
      const lineCount = Math.min(model.getLineCount(), MAX_SCANNED_LINES);

      const links: ImportLink[] = [];
      for (let line = 1; line <= lineCount; line++) {
        const lineText = model.getLineContent(line);
        for (const s of extractSpecifiers(lineText)) {
          links.push({
            range: {
              startLineNumber: line,
              startColumn: s.startCol,
              endLineNumber: line,
              endColumn: s.endCol,
            },
            spec: s.spec,
            filePath,
          });
        }
      }
      return { links };
    },

    // Links from provideLinks intentionally omit `url` — resolving every
    // specifier in the file up front would mean one `path_exists` IPC round
    // trip (possibly several, per candidate) per import, on every edit, off
    // the back of a synchronous scan. Monaco calls resolveLink lazily, once,
    // only for the single link the user is actually hovering/clicking, so
    // the async work never blocks the UI thread or scales with file size.
    async resolveLink(link: languages.ILink) {
      const importLink = link as ImportLink;
      if (!importLink.filePath || !importLink.spec) return null;

      const target = await resolveSpecifier(importLink.filePath, importLink.spec);
      if (!target) return null; // unresolvable → no link (Cmd+click / underline becomes a no-op)

      return {
        range: importLink.range,
        url: monaco.Uri.file(target),
      };
    },
  };
}

let registered = false;

/**
 * Registers the import-path DefinitionProvider + LinkProvider for the
 * `typescript`/`javascript` Monaco languages. Idempotent (module-level
 * guard, same pattern as `shader-languages/index.ts`) — safe to call from
 * every `MonacoEditor` mount.
 */
export function registerImportLinkProvider(monaco: Monaco): void {
  if (registered) return;
  registered = true;

  ensureCacheInvalidationSubscribed();

  const definitionProvider = createDefinitionProvider(monaco);
  const linkProvider = createLinkProvider(monaco);

  monaco.languages.registerDefinitionProvider(TS_LANG_ID, definitionProvider);
  monaco.languages.registerDefinitionProvider(JS_LANG_ID, definitionProvider);
  monaco.languages.registerLinkProvider(TS_LANG_ID, linkProvider);
  monaco.languages.registerLinkProvider(JS_LANG_ID, linkProvider);
}
