import type { editor } from 'monaco-editor';
import type { LspClient } from './client';
import { lspManager } from './manager';
import { fileUri } from './document-sync';
import { detectLanguage } from '../../../utils/language-detect';

/**
 * Shared LSP↔Monaco glue used by every provider module (providers.ts,
 * code-actions.ts, rename-provider.ts). Lives in its own file so those
 * modules don't need to import each other.
 */

// ── Canonical LSP position/range types ──────────────────────────
// Structural mirrors of the protocol types (not imported from an LSP
// package). This module is their canonical home — every other LSP
// service module imports them from here.

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** Convert an LSP range (0-based) to a Monaco IRange (1-based). */
export function toMonacoRange(range: LspRange) {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

/** Convert a Monaco position (1-based) to an LSP position (0-based). */
export function toLspPosition(position: { lineNumber: number; column: number }): LspPosition {
  return {
    line: position.lineNumber - 1,
    character: position.column - 1,
  };
}

/** Convert a Monaco IRange (1-based) to an LSP range (0-based). */
export function toLspRange(range: {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}): LspRange {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
  };
}

// ── The document URI that goes on the wire ──────────────────────
//
// **Never send `model.uri.toString()` to a language server.** Monaco's
// `Uri.toString()` is not the identity on the `file:///D:/x/A.cs` this app
// hands it: `_asFormatted` lower-cases the drive letter AND percent-encodes
// its colon, so the model whose URI was built from `file:///C:/x/A.cs` renders
// as `file:///c%3A/x/A.cs`. Every notification (`didOpen`/`didChange`) is sent
// under `fileUri(path)`, so a request built from `toString()` names a document
// the server has never been told about — and Roslyn answers `null` to every
// completion, hover, definition, code action and diagnostic pull for it. That
// shipped, and it made C# IntelliSense look "partly working" on Windows
// because Monaco's word-based suggestions and this app's static Unity
// providers kept answering while the LSP answered nothing at all.
//
// On csharp-ls 0.24+ the same mismatch is worse than useless: a `didOpen`
// for a document outside the solution is *added* to the workspace, so the
// phantom URI would compile a second copy of the file and report duplicate
// type definitions against the real one.
//
// `fileUri` (document-sync.ts) is therefore the single builder for both
// directions. `model.uri.toString()` stays the right key for Monaco-internal
// maps (markers, pull timers, ui-store diagnostics) — it just never crosses
// the wire.

/**
 * Rebuild the original file path from a Monaco model URI.
 *
 * Reads `.authority`/`.path` rather than `toString()` or `fsPath`: `.path` is
 * already percent-decoded and preserves the drive letter's case, while
 * `fsPath` lower-cases the drive and uses backslashes on Windows. Mirrors the
 * three shapes `fileUri` produces.
 */
export function modelFilePath(model: {
  uri: { authority?: string; path: string };
}): string {
  const { authority, path } = model.uri;
  // UNC — `fileUri` collapsed `//host/share` into the authority position.
  if (authority) return `//${authority}${path}`;
  // Windows drive — the leading slash is the URI's, not the path's.
  if (/^\/[A-Za-z]:(\/|$)/.test(path)) return path.slice(1);
  return path;
}

/**
 * The URI to name `model` by in an LSP request. Always equal to the
 * `fileUri(filePath)` the document was opened under.
 */
export function lspDocumentUri(model: {
  uri: { authority?: string; path: string };
}): string {
  return fileUri(modelFilePath(model));
}

export function buildTextDocumentPositionParams(
  model: { uri: { authority?: string; path: string } },
  position: { lineNumber: number; column: number },
) {
  return {
    textDocument: { uri: lspDocumentUri(model) },
    position: toLspPosition(position),
  };
}

/**
 * Resolve the running LSP client for a given model along with the LSP
 * `languageId` to use for `didOpen`. Returns null when:
 *   - the model is virtual (diff://, auth://)
 *   - the file's extension has no LSP server defined
 *   - the language's server has not been started yet
 *
 * Providers should treat null as "no LSP available" and return empty.
 */
export function getLspContextForModel(
  model: editor.ITextModel,
): { client: LspClient; lspLanguageId: string } | null {
  if (model.uri.scheme !== 'file') return null;

  const filename = modelFilePath(model).split('/').pop() ?? '';
  const info = detectLanguage(filename);
  if (!info.lspServerKey || !info.lspLanguageId) return null;

  const client = lspManager.client(info.lspServerKey);
  if (!client.isRunning()) return null;
  return { client, lspLanguageId: info.lspLanguageId };
}
