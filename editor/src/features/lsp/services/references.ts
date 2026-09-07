/**
 * `textDocument/references` as a callable query.
 *
 * The provider in `providers.ts` hands its results straight to Monaco's peek
 * widget and keeps nothing, so a panel that wants the same data has to ask
 * again. Same request, plain shape, no Monaco types on the way out — the store
 * that consumes this has no business importing `monaco-editor`.
 */

import { LspRequestCanceledError } from './client';
import {
  getLspContextForModel,
  buildTextDocumentPositionParams,
  type LspRange,
} from './model-context';
import { pathFromFileUri } from './document-sync';
import type { editor, Position } from 'monaco-editor';

export interface ReferenceHit {
  path: string;
  /** 1-based, matching Monaco and every UI that shows it. */
  line: number;
  /** 1-based. */
  column: number;
}

interface LspLocation {
  uri: string;
  range: LspRange;
}

export class NoLanguageServerError extends Error {
  constructor() {
    super('No language server is running for this file');
    this.name = 'NoLanguageServerError';
  }
}

/**
 * Every reference to the symbol under `position`, declaration included.
 *
 * Throws `NoLanguageServerError` when nothing serves this file, so the caller
 * can say so rather than reporting "no usages" — those are different answers.
 * Returns `null` only when the request was cancelled.
 */
export async function queryReferences(
  model: editor.ITextModel,
  position: Position,
): Promise<ReferenceHit[] | null> {
  const ctx = getLspContextForModel(model);
  if (!ctx) throw new NoLanguageServerError();

  let result: LspLocation[] | null;
  try {
    result = await ctx.client.request<LspLocation[] | null>('textDocument/references', {
      ...buildTextDocumentPositionParams(model, position),
      context: { includeDeclaration: true },
    });
  } catch (err) {
    if (err instanceof LspRequestCanceledError) return null;
    throw err;
  }

  if (!result) return [];
  return result.map((loc) => ({
    path: pathFromFileUri(loc.uri),
    // LSP positions are 0-based; everything downstream of here is 1-based.
    line: loc.range.start.line + 1,
    column: loc.range.start.character + 1,
  }));
}
