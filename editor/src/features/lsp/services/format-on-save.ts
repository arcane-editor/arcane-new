/**
 * Format-on-save.
 *
 * Deliberately NOT `editor.action.formatDocument`: that action runs against the
 * *focused* editor, and the file being written is often not it — `onFocusChange`
 * auto-save saves the tab you just left, and the search panel's Save All writes
 * several files at once. This goes straight to the language server for a named
 * path instead.
 *
 * Edits are applied through `pushEditOperations` rather than `setValue` so the
 * reformat lands as one undoable step on top of the user's own history instead
 * of erasing it.
 */

import { getMonacoInstance } from '../../../utils/monaco-instance';
import type { LspClient } from './client';
import { fileUri } from './document-sync';
import { lspDocumentUri, toMonacoRange, type LspRange } from './model-context';

interface LspTextEdit {
  range: LspRange;
  newText: string;
}

/**
 * Format `path` in place and return the resulting text.
 *
 * Returns `null` whenever the caller should just save what it already has:
 * no open model, no edits, or the server declined. Never throws — a formatter
 * must not be able to block a save.
 */
export async function formatDocumentBeforeSave(
  client: LspClient,
  path: string,
): Promise<string | null> {
  const monaco = getMonacoInstance();
  if (!monaco) return null;

  const model = monaco.editor.getModel(monaco.Uri.parse(fileUri(path)));
  // No model means no open tab. `saveFile` only ever writes open tabs, so this
  // is a torn-down-mid-save race rather than a real case; save unformatted.
  if (!model || model.isDisposed()) return null;

  // Take the indentation the model is actually using rather than the setting:
  // Monaco may have detected it from the file, and formatting to a different
  // width than the editor displays would reindent the whole file on save.
  const { tabSize, insertSpaces } = model.getOptions();

  let edits: LspTextEdit[] | null = null;
  try {
    edits = await client.request<LspTextEdit[] | null>('textDocument/formatting', {
      // Never `model.uri.toString()`: Monaco renders a Windows drive letter
      // lower-cased and percent-encoded, which is not the URI `didOpen` used,
      // so the server answers null and the file saves unformatted forever.
      textDocument: { uri: lspDocumentUri(model) },
      options: { tabSize, insertSpaces },
    });
  } catch (err) {
    console.warn('[LSP] Format on save failed; saving unformatted:', err);
    return null;
  }

  if (!edits || edits.length === 0) return null;
  if (model.isDisposed()) return null;

  model.pushEditOperations(
    null,
    edits.map((e) => ({ range: toMonacoRange(e.range), text: e.newText })),
    () => null,
  );

  return model.getValue();
}
