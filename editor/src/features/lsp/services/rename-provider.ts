import type { Monaco } from '@monaco-editor/react';
import type { editor, Position } from 'monaco-editor';
import { LspRequestCanceledError } from './client';
import {
  getLspContextForModel,
  toMonacoRange,
  buildTextDocumentPositionParams,
  type LspRange,
} from './model-context';
import { applyLspWorkspaceEdit, type LspWorkspaceEdit } from './workspace-edit';
import { LSP_BACKED_MONACO_LANGUAGES } from '../../../utils/language-detect';

// ── LSP rename types (structural, not imported) ─────────────────

/** Result of `textDocument/prepareRename` (LSP 3.12 / 3.16 variants). */
type LspPrepareRenameResult =
  | LspRange
  | { range: LspRange; placeholder: string }
  | { defaultBehavior: boolean }
  | null;

// ── Rename post-processors ──────────────────────────────────────

export interface RenamePostProcessContext {
  model: editor.ITextModel;
  position: Position;
  /** Word at the rename position before the rename. */
  oldName: string;
  newName: string;
  /** The (possibly already post-processed) LSP WorkspaceEdit. */
  workspaceEdit: LspWorkspaceEdit;
}

export type RenamePostProcessor = (
  ctx: RenamePostProcessContext,
) => Promise<LspWorkspaceEdit> | LspWorkspaceEdit;

const renamePostProcessors: RenamePostProcessor[] = [];

/**
 * Register a hook that runs after the LSP returns its rename
 * WorkspaceEdit and before it is applied. The hook returns the
 * (possibly augmented) edit; multiple processors compose in
 * registration order. (Unity's FormerlySerializedAs feature injects
 * additional edits through this.) Returns an unregister function.
 */
export function registerRenamePostProcessor(fn: RenamePostProcessor): () => void {
  renamePostProcessors.push(fn);
  return () => {
    const idx = renamePostProcessors.indexOf(fn);
    if (idx >= 0) renamePostProcessors.splice(idx, 1);
  };
}

async function runRenamePostProcessors(
  ctx: Omit<RenamePostProcessContext, 'workspaceEdit'>,
  initial: LspWorkspaceEdit,
): Promise<LspWorkspaceEdit> {
  let edit = initial;
  for (const fn of renamePostProcessors) {
    try {
      edit = await fn({ ...ctx, workspaceEdit: edit });
    } catch (err) {
      console.warn('[LSP] Rename post-processor failed (skipping):', err);
    }
  }
  return edit;
}

// ── Provider registration ───────────────────────────────────────

/**
 * Register the LSP-backed RenameProvider (F2 rename + prepareRename
 * validation) for every LSP language. Called from `registerLspProviders`
 * so registration/disposal stays in one place. Returns a dispose fn.
 */
export function registerLspRenameProviders(monaco: Monaco): () => void {
  const disposables: Array<{ dispose(): void }> = [];

  for (const lang of LSP_BACKED_MONACO_LANGUAGES) {
    disposables.push(
      monaco.languages.registerRenameProvider(lang, {
        async provideRenameEdits(
          model: editor.ITextModel,
          position: Position,
          newName: string,
        ) {
          const ctx = getLspContextForModel(model);
          if (!ctx) {
            return { edits: [], rejectReason: 'No language server is available for rename' };
          }

          try {
            const params = {
              ...buildTextDocumentPositionParams(model, position),
              newName,
            };
            const result = await ctx.client.request<LspWorkspaceEdit | null>(
              'textDocument/rename',
              params,
            );
            if (!result) {
              return {
                edits: [],
                rejectReason: 'The language server cannot rename this element',
              };
            }

            const oldName = model.getWordAtPosition(position)?.word ?? '';
            const finalEdit = await runRenamePostProcessors(
              { model, position, oldName, newName },
              result,
            );

            // Monaco's standalone bulk-edit service only applies edits to
            // models that are currently open, silently dropping rename
            // edits in closed files. So we apply the full WorkspaceEdit
            // ourselves (open models get undo-friendly pushEditOperations;
            // closed files are rewritten on disk) and return an empty edit
            // to Monaco. Tradeoff: cross-file undo is per-file — Cmd+Z in
            // the active editor won't revert the other touched files.
            const summary = await applyLspWorkspaceEdit(finalEdit);
            console.info('[LSP] Rename applied', { newName, ...summary });
            return { edits: [] };
          } catch (err) {
            if (err instanceof LspRequestCanceledError) return { edits: [] };
            console.error('[LSP] Rename error:', err);
            return {
              edits: [],
              rejectReason: err instanceof Error ? err.message : String(err),
            };
          }
        },

        async resolveRenameLocation(model: editor.ITextModel, position: Position) {
          // Monaco-default behavior: rename the word under the cursor.
          const fallback = () => {
            const word = model.getWordAtPosition(position);
            if (!word) {
              throw new Error('You cannot rename this element.');
            }
            return {
              range: {
                startLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endLineNumber: position.lineNumber,
                endColumn: word.endColumn,
              },
              text: word.word,
            };
          };

          const ctx = getLspContextForModel(model);
          if (!ctx) return fallback();

          // Only servers that advertise `renameProvider.prepareProvider`
          // in their initialize capabilities support prepareRename.
          const caps = ctx.client.getServerCapabilities() as {
            renameProvider?: boolean | { prepareProvider?: boolean };
          } | null;
          const prepareSupported =
            typeof caps?.renameProvider === 'object' &&
            caps.renameProvider !== null &&
            caps.renameProvider.prepareProvider === true;
          if (!prepareSupported) return fallback();

          let result: LspPrepareRenameResult;
          try {
            result = await ctx.client.request<LspPrepareRenameResult>(
              'textDocument/prepareRename',
              buildTextDocumentPositionParams(model, position),
            );
          } catch (err) {
            if (err instanceof LspRequestCanceledError) return fallback();
            console.error('[LSP] prepareRename error:', err);
            throw err instanceof Error ? err : new Error(String(err));
          }

          // Null ⇒ rename is not valid at this position.
          if (result == null) {
            throw new Error('The language server cannot rename this element.');
          }

          if ('defaultBehavior' in result) return fallback();

          if ('placeholder' in result) {
            return { range: toMonacoRange(result.range), text: result.placeholder };
          }

          const range = toMonacoRange(result);
          return { range, text: model.getValueInRange(range) };
        },
      }),
    );
  }

  return () => {
    for (const d of disposables) d.dispose();
  };
}
