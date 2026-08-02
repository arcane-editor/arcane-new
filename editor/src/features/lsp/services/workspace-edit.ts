import { invoke } from '@tauri-apps/api/core';
import type { editor } from 'monaco-editor';
import type { Monaco } from '@monaco-editor/react';
import { getMonacoInstance } from '../../../utils/monaco-instance';
import { useWorkspaceStore } from '../../../stores/workspace';
import { notify } from '../../../stores/notifications';
import { fileUri, pathFromFileUri } from './document-sync';
import { setApplyEditHandler } from './client';
import type { LspPosition, LspRange } from './model-context';

// ── LSP WorkspaceEdit types (structural, not imported) ──────────
// LspPosition/LspRange live in ./model-context (canonical home).

export interface LspTextEdit {
  range: LspRange;
  newText: string;
  /** Present on AnnotatedTextEdit — harmless, ignored by the applier. */
  annotationId?: string;
}

export interface LspTextDocumentEdit {
  textDocument: { uri: string; version?: number | null };
  edits: LspTextEdit[];
}

/**
 * CreateFile / RenameFile / DeleteFile resource operations. Recognised
 * (so we don't crash) but not applied yet — counted as `skippedOps`.
 */
export interface LspResourceOperation {
  kind: 'create' | 'rename' | 'delete';
  [key: string]: unknown;
}

export type LspDocumentChange = LspTextDocumentEdit | LspResourceOperation;

export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: LspDocumentChange[];
}

export interface AppliedWorkspaceEditSummary {
  /** Files that received at least one text edit. */
  filesChanged: number;
  /** Total individual text edits applied across all files. */
  editsApplied: number;
  /** Resource operations (create/rename/delete file) we don't handle yet. */
  skippedOps: number;
  /** Files whose edits failed to apply (the rest still get applied). */
  failedFiles: Array<{ path: string; error: string }>;
}

// ── URI helpers ─────────────────────────────────────────────────

/**
 * Convert a `file://` URI to a filesystem path — the exact inverse of
 * `fileUri()`, so a Windows drive path survives the round trip (`file:///D:/x`
 * → `D:/x`, not `/D:/x`, which the Rust side then can't open).
 */
function uriToFsPath(uri: string): string | null {
  if (!uri.startsWith('file://')) return null;
  return pathFromFileUri(uri);
}

/**
 * Locate an open Monaco model for an LSP uri. Tries the uri as-is, then
 * the canonical encoding produced by `fileUri()` (the same encoding
 * EditorPanel uses for model paths), then falls back to a decoded-path
 * scan so encoding mismatches between the server and Monaco can't make
 * us miss an open buffer.
 */
function findModelForUri(
  monaco: Monaco,
  uri: string,
  fsPath: string,
): editor.ITextModel | null {
  const direct = monaco.editor.getModel(monaco.Uri.parse(uri));
  if (direct) return direct;

  const canonical = monaco.editor.getModel(monaco.Uri.parse(fileUri(fsPath)));
  if (canonical) return canonical;

  for (const model of monaco.editor.getModels()) {
    const modelUri = model.uri.toString();
    if (!modelUri.startsWith('file://')) continue;
    // Same inverse as `uriToFsPath` above — comparing a differently-decoded
    // spelling against `fsPath` would make this fallback dead code.
    if (pathFromFileUri(modelUri) === fsPath) {
      return model;
    }
  }
  return null;
}

// ── Edit normalization ──────────────────────────────────────────

function isTextDocumentEdit(change: LspDocumentChange): change is LspTextDocumentEdit {
  return (change as LspTextDocumentEdit).textDocument !== undefined;
}

/**
 * Flatten either WorkspaceEdit shape into per-uri edit lists. Per the
 * LSP spec, `documentChanges` is preferred over `changes` when both are
 * present.
 */
function normalizeWorkspaceEdit(workspaceEdit: LspWorkspaceEdit): {
  fileEdits: Array<{ uri: string; edits: LspTextEdit[] }>;
  skippedOps: number;
} {
  const byUri = new Map<string, LspTextEdit[]>();
  let skippedOps = 0;

  if (workspaceEdit.documentChanges && workspaceEdit.documentChanges.length > 0) {
    for (const change of workspaceEdit.documentChanges) {
      if (!isTextDocumentEdit(change)) {
        skippedOps++;
        continue;
      }
      const uri = change.textDocument.uri;
      const list = byUri.get(uri) ?? [];
      list.push(...change.edits);
      byUri.set(uri, list);
    }
  } else if (workspaceEdit.changes) {
    for (const [uri, edits] of Object.entries(workspaceEdit.changes)) {
      const list = byUri.get(uri) ?? [];
      list.push(...edits);
      byUri.set(uri, list);
    }
  }

  return {
    fileEdits: [...byUri.entries()].map(([uri, edits]) => ({ uri, edits })),
    skippedOps,
  };
}

/**
 * Sort edits bottom-up (descending start position) so applying one edit
 * never invalidates the offsets/ranges of the edits still to come.
 * JS sort is stable, so multiple inserts at the same position keep
 * their array order after bottom-up application (LSP spec semantics).
 */
function sortEditsBottomUp(edits: LspTextEdit[]): LspTextEdit[] {
  return [...edits].sort((a, b) => {
    if (a.range.start.line !== b.range.start.line) {
      return b.range.start.line - a.range.start.line;
    }
    return b.range.start.character - a.range.start.character;
  });
}

// ── String-based application (closed files) ─────────────────────

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

/**
 * LSP position → string offset. Positions are UTF-16 code-unit based,
 * which matches JS string indexing exactly. Out-of-range lines clamp to
 * EOF and out-of-range characters clamp to the line end (per spec).
 */
function offsetAt(text: string, lineStarts: number[], pos: LspPosition): number {
  if (pos.line < 0) return 0;
  if (pos.line >= lineStarts.length) return text.length;

  const lineStart = lineStarts[pos.line];
  let lineEnd: number;
  if (pos.line + 1 < lineStarts.length) {
    lineEnd = lineStarts[pos.line + 1] - 1; // position of '\n'
    if (lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 13 /* \r */) {
      lineEnd -= 1;
    }
  } else {
    lineEnd = text.length;
  }

  return Math.min(lineStart + Math.max(0, pos.character), lineEnd);
}

/** Apply LSP text edits to a plain string (bottom-up). */
function applyEditsToText(text: string, edits: LspTextEdit[]): string {
  const lineStarts = computeLineStarts(text);
  let result = text;
  for (const edit of sortEditsBottomUp(edits)) {
    const startOffset = offsetAt(text, lineStarts, edit.range.start);
    const endOffset = offsetAt(text, lineStarts, edit.range.end);
    result = result.slice(0, startOffset) + edit.newText + result.slice(endOffset);
  }
  return result;
}

// ── Model-based application (open files) ────────────────────────

/**
 * Apply LSP text edits to an open Monaco model via `pushEditOperations`
 * so the change lands on the model's undo stack (Cmd+Z friendly).
 * LSP ranges are 0-based; Monaco ranges are 1-based.
 */
function applyEditsToModel(
  monaco: Monaco,
  model: editor.ITextModel,
  edits: LspTextEdit[],
): void {
  const operations = sortEditsBottomUp(edits).map((edit) => ({
    range: new monaco.Range(
      edit.range.start.line + 1,
      edit.range.start.character + 1,
      edit.range.end.line + 1,
      edit.range.end.character + 1,
    ),
    text: edit.newText,
    forceMoveMarkers: false,
  }));

  model.pushStackElement();
  model.pushEditOperations(null, operations, () => null);
  model.pushStackElement();
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Apply an LSP `WorkspaceEdit` across the whole workspace.
 *
 * Per file:
 *  - Open Monaco model → `pushEditOperations` (undo-friendly), then the
 *    workspace store buffer is refreshed (marks the tab dirty and sends
 *    `didChange` to the right LSP — same path as typing).
 *  - No model but the file is open in a tab → edits applied to the tab's
 *    buffer text (marks dirty, syncs LSP).
 *  - Fully closed file → read from disk, apply edits bottom-up, write
 *    back via the Tauri fs layer.
 *
 * CreateFile / RenameFile / DeleteFile operations are not applied yet —
 * they're counted in `skippedOps` instead of crashing the whole edit.
 *
 * Note: cross-file undo is per-file. Edits to open models are individually
 * undoable; edits written straight to disk are not undoable from the editor.
 */
export async function applyLspWorkspaceEdit(
  workspaceEdit: LspWorkspaceEdit,
): Promise<AppliedWorkspaceEditSummary> {
  const summary: AppliedWorkspaceEditSummary = {
    filesChanged: 0,
    editsApplied: 0,
    skippedOps: 0,
    failedFiles: [],
  };
  if (!workspaceEdit) return summary;

  const { fileEdits, skippedOps } = normalizeWorkspaceEdit(workspaceEdit);
  summary.skippedOps = skippedOps;

  const monaco = getMonacoInstance();

  for (const { uri, edits } of fileEdits) {
    if (edits.length === 0) continue;

    const fsPath = uriToFsPath(uri);
    if (!fsPath) {
      console.warn('[LSP] applyLspWorkspaceEdit: skipping non-file uri', { uri });
      summary.skippedOps++;
      continue;
    }

    try {
      const workspace = useWorkspaceStore.getState();
      const openFile = workspace.openFiles.find((f) => f.path === fsPath);
      const model = monaco ? findModelForUri(monaco, uri, fsPath) : null;

      if (monaco && model) {
        // Open buffer: undo-friendly model edit.
        applyEditsToModel(monaco, model, edits);

        // Exactly ONE didChange per file. EditorPanel mounts a single
        // Monaco editor and swaps models per tab (the `path` prop), and
        // @monaco-editor/react's onChange fires for programmatic
        // pushEditOperations too — but only for the model currently
        // ATTACHED to that mounted editor. For the attached (active-tab)
        // model, onChange → updateFileContent → syncDocumentChange has
        // already run by the time applyEditsToModel returns, so an
        // explicit updateFileContent here would send a duplicate
        // didChange. Background-tab models are not attached to any
        // editor, get NO onChange, and need the explicit store refresh
        // (tab dirty flag) + LSP sync below.
        const attachedToMountedEditor = monaco.editor
          .getEditors()
          .some((ed: editor.ICodeEditor) => ed.getModel() === model);

        if (openFile) {
          if (!attachedToMountedEditor) {
            workspace.updateFileContent(fsPath, model.getValue());
          }
        } else {
          // Model exists but no tab tracks it (e.g. closed tab whose
          // model Monaco kept alive) — persist to disk so the edit
          // isn't stranded in a dangling buffer.
          await invoke('write_file', { path: fsPath, contents: model.getValue() });
        }
      } else if (openFile) {
        // Tab open but no model mounted yet: edit the buffer text.
        workspace.updateFileContent(fsPath, applyEditsToText(openFile.content, edits));
      } else {
        // Closed file: read → apply bottom-up → write back.
        const content = await invoke<string>('read_file', { path: fsPath });
        await invoke('write_file', {
          path: fsPath,
          contents: applyEditsToText(content, edits),
        });
      }

      summary.filesChanged++;
      summary.editsApplied += edits.length;
    } catch (err) {
      // Keep applying the remaining files; collect the failure so
      // callers (and the user, via the notification below) see it.
      summary.failedFiles.push({
        path: fsPath,
        error: err instanceof Error ? err.message : String(err),
      });
      console.error('[LSP] applyLspWorkspaceEdit: failed for file', { uri, fsPath, error: err });
    }
  }

  if (summary.failedFiles.length > 0) {
    const first = summary.failedFiles[0].path;
    notify.error(
      `Workspace edit applied with ${summary.failedFiles.length} failure${
        summary.failedFiles.length === 1 ? '' : 's'
      }: ${first}${summary.failedFiles.length > 1 ? '…' : ''}`,
    );
  }

  // Only log when something noteworthy happened (skipped resource ops
  // or per-file failures) — clean applies stay quiet.
  if (summary.skippedOps > 0 || summary.failedFiles.length > 0) {
    console.info('[LSP] applyLspWorkspaceEdit summary', summary);
  }
  return summary;
}

// ── workspace/applyEdit (server→client) wiring ──────────────────

/**
 * Register `applyLspWorkspaceEdit` as the handler for server-initiated
 * `workspace/applyEdit` requests. client.ts cannot import this module
 * directly — workspace-edit.ts → stores/workspace.ts → features/lsp
 * barrel → client.ts would form an import cycle — so the dependency is
 * injected via `setApplyEditHandler`. Called from provider registration
 * (registerLspProviders); returns an unregister function.
 */
export function registerApplyEditHandler(): () => void {
  setApplyEditHandler(async (edit) => {
    const summary = await applyLspWorkspaceEdit(edit as LspWorkspaceEdit);
    if (summary.failedFiles.length > 0) {
      const { path, error } = summary.failedFiles[0];
      return {
        applied: false,
        failureReason:
          `Failed to apply edits to ${summary.failedFiles.length} file(s); ` +
          `first failure: ${path} — ${error}`,
      };
    }
    return { applied: true };
  });
  return () => setApplyEditHandler(null);
}
