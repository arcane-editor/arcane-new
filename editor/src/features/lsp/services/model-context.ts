import type { editor } from 'monaco-editor';
import type { LspClient } from './client';
import { lspManager } from './manager';
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

export function buildTextDocumentPositionParams(
  model: { uri: { toString(): string } },
  position: { lineNumber: number; column: number },
) {
  return {
    textDocument: { uri: model.uri.toString() },
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
  const uri = model.uri.toString();
  if (!uri.startsWith('file://')) return null;

  const filename = decodeURIComponent(uri.split('/').pop() ?? '');
  const info = detectLanguage(filename);
  if (!info.lspServerKey || !info.lspLanguageId) return null;

  const client = lspManager.client(info.lspServerKey);
  if (!client.isRunning()) return null;
  return { client, lspLanguageId: info.lspLanguageId };
}
