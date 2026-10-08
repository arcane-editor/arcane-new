import { invoke } from '@tauri-apps/api/core';
import type { editor } from 'monaco-editor';
import type { Monaco } from '@monaco-editor/react';
import { getMonacoInstance } from '../../../utils/monaco-instance';
import { useWorkspaceStore } from '../../../stores/workspace';
import { notify } from '../../../stores/notifications';
import { fileUri, getDocumentVersion } from './document-sync';
import { documentIdentity, normalizeWorkspaceEdit, applyEditsToText } from './workspace-edit-plan';
import { setApplyEditHandler } from './client';
import { modelFilePath, type LspRange } from './model-context';
import { requestWorkspaceChangePreview, finishWorkspaceChangePreview } from '../../../stores/workspace-change-preview';

// ── LSP WorkspaceEdit types (structural, not imported) ──────────
// LspPosition/LspRange live in ./model-context (canonical home).

export interface LspTextEdit {
  range: LspRange;
  newText: string;
  /** Present on AnnotatedTextEdit. */
  annotationId?: string;
}

export interface LspTextDocumentEdit {
  textDocument: { uri: string; version?: number | null };
  edits: LspTextEdit[];
}

/**
 * Resource operations are recognized and reject the complete edit until
 * transactional resource handling is available.
 */
export interface LspResourceOperation {
  kind: 'create' | 'rename' | 'delete';
  uri?: string;
  oldUri?: string;
  newUri?: string;
}

export type LspDocumentChange = LspTextDocumentEdit | LspResourceOperation;

export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: LspDocumentChange[];
}

export interface AppliedWorkspaceEditSummary {
  cancelled: boolean;
  /** Files that received at least one text edit. */
  filesChanged: number;
  /** Total individual text edits applied across all files. */
  editsApplied: number;
  /** Always zero: unsupported operations reject the entire edit. */
  skippedOps: number;
  /** Failure or recovery detail; no partial result is reported as success. */
  failedFiles: Array<{ path: string; error: string }>;
}

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
    if (model.uri.scheme !== 'file') continue;
    // `modelFilePath`, not `pathFromFileUri(model.uri.toString())`: Monaco's
    // rendering lower-cases the drive letter, so on Windows the decoded
    // spelling would never equal the server's `fsPath` and this fallback
    // would be dead code.
    if (documentIdentity(modelFilePath(model)) === documentIdentity(fsPath)) {
      return model;
    }
  }
  return null;
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
  const operations = edits.map((edit) => ({
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

interface Snapshot {
  path: string;
  before: string;
  after: string;
  buffer: boolean;
  model: editor.ITextModel | null;
  modelVersion?: number;
  documentVersion?: number;
  edits: LspTextEdit[];
}
interface Transaction { id: string; workspacePath: string; snapshots: Snapshot[] }
let lastTransaction: Transaction | null = null;
let pending: Promise<unknown> = Promise.resolve();

export function captureWorkspaceEditVersions(): Map<string, { content: string; version?: number }> {
  return new Map(useWorkspaceStore.getState().openFiles.map(f => [documentIdentity(f.path), { content: f.content, version: getDocumentVersion(f.path) }]));
}

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const result = pending.then(work, work);
  pending = result.catch(() => {});
  return result;
}

/** Cancel previews and drain queued changes before checking dirty buffers on
 * window close. A completed disk change must not outlive its buffer update. */
export async function settleWorkspaceChanges(): Promise<void> {
  finishWorkspaceChangePreview(false);
  await pending;
}

function assertUnchanged(snapshots: Snapshot[]): void {
  const workspace = useWorkspaceStore.getState();
  for (const s of snapshots) {
    if (s.model && (s.model.isDisposed() || s.model.getVersionId() !== s.modelVersion)) throw new Error(`${s.path} changed while preparing the edit`);
    const open = workspace.openFiles.find(f => documentIdentity(f.path) === documentIdentity(s.path));
    if (s.buffer && (!open || open.content !== s.before || getDocumentVersion(s.path) !== s.documentVersion)) throw new Error(`${s.path} changed while preparing the edit`);
    if (!s.buffer && open) throw new Error(`${s.path} was opened while preparing the edit; retry`);
  }
}

function updateBuffer(monaco: Monaco | null, s: Snapshot, text: string, fullReplacement = false): void {
  const model = s.model;
  if (monaco && model && !model.isDisposed()) {
    if (text === s.after && !fullReplacement) applyEditsToModel(monaco, model, s.edits);
    else {
      model.pushStackElement();
      model.pushEditOperations(null, [{ range: model.getFullModelRange(), text }], () => null);
      model.pushStackElement();
    }
    if (model.getValue() !== text) throw new Error(`${s.path} did not match the prepared edit; recovery is required`);
  }
  const workspace = useWorkspaceStore.getState();
  // Attached editors may already have sent didChange through onChange.
  if (workspace.openFiles.find(f => f.path === s.path)?.content !== text) workspace.updateFileContent(s.path, text);
  if (text === s.before) {
    useWorkspaceStore.setState(state => ({ openFiles: state.openFiles.map(f => f.path === s.path ? { ...f, isDirty: f.diskContent !== text } : f) }));
  }
}

/** All files are prepared before the first mutation. Unsupported operations,
 * stale buffers and invalid ranges reject the entire request. Closed-file
 * writes have a durable recovery journal and compare-before-write rollback.
 * Cross-process edits during recovery are reported, never overwritten. */
export function applyLspWorkspaceEdit(workspaceEdit: LspWorkspaceEdit, options: { preview?: boolean; expectedBuffers?: ReturnType<typeof captureWorkspaceEditVersions>; expectedTexts?: ReadonlyMap<string, string> } = {}): Promise<AppliedWorkspaceEditSummary> {
  return serialized(async () => {
    const summary: AppliedWorkspaceEditSummary = { cancelled: false, filesChanged: 0, editsApplied: 0, skippedOps: 0, failedFiles: [] };
    let transactionId: string | undefined;
    const snapshots: Snapshot[] = [];
    const workspacePath = useWorkspaceStore.getState().workspacePath;
    try {
      if (!workspacePath) throw new Error('Open a workspace before applying changes');
      const monaco = getMonacoInstance();
      const documents = normalizeWorkspaceEdit(workspaceEdit);
      const openPaths = useWorkspaceStore.getState().openFiles.map(f => f.path);
      const identities = await invoke<Record<string, string>>('workspace_edit_identities', { paths: [...new Set([...documents.map(d => d.path), ...openPaths.filter(p => !p.includes('://'))])] });
      const grouped = new Map<string, typeof documents[number]>();
      for (const document of documents) {
        if (!document.edits.length) continue;
        const id = identities[document.path];
        if (!id) throw new Error(`Cannot resolve document identity: ${document.path}`);
        const prior = grouped.get(id);
        if (prior) {
          if (prior.version != null && document.version != null && prior.version !== document.version) throw new Error(`Conflicting document versions: ${document.path}`);
          prior.version ??= document.version;
          prior.edits.push(...document.edits);
        } else grouped.set(id, { ...document, edits: [...document.edits] });
      }
      const checkCurrent = () => {
        assertUnchanged(snapshots);
        const current = useWorkspaceStore.getState().openFiles.map(f => f.path);
        if (current.length !== openPaths.length || current.some(p => !openPaths.includes(p))) throw new Error('Open documents changed while preparing this operation; retry');
      };
      for (const file of grouped.values()) {
        if (!file.edits.length) continue;
        const workspace = useWorkspaceStore.getState();
        const aliases = workspace.openFiles.filter(f => identities[f.path] === identities[file.path]);
        if (aliases.length > 1) throw new Error(`Close duplicate views of ${file.path} before applying changes`);
        const open = aliases[0];
        const path = open?.path ?? file.path;
        const expected = options.expectedBuffers?.get(documentIdentity(path));
        if (options.expectedBuffers && (expected ? !open || open.content !== expected.content || getDocumentVersion(path) !== expected.version : !!open)) {
          throw new Error(`${path} changed while the language server was preparing the edit; retry`);
        }
        if (open?.isBinary || open?.isTooLarge || open?.saveConflict) throw new Error(`${path} cannot be edited until its conflict is resolved`);
        const model = monaco ? findModelForUri(monaco, file.uri, path) : null;
        const documentVersion = getDocumentVersion(path);
        if (file.version != null && file.version !== documentVersion) throw new Error(`${path} has a stale or unknown document version`);
        const before = open ? (model?.getValue() ?? open.content) : await invoke<string>('read_file', { path });
        const expectedText = options.expectedTexts?.get(documentIdentity(file.path)) ?? options.expectedTexts?.get(documentIdentity(path));
        if (expectedText !== undefined && before !== expectedText) throw new Error(`${path} changed while deriving the refactoring; retry`);
        if (open && before !== open.content) throw new Error(`${path} buffer is not synchronized; retry`);
        const after = applyEditsToText(before, file.edits);
        snapshots.push({ path, before, after, buffer: !!open, model: open ? model : null, modelVersion: open ? model?.getVersionId() : undefined, documentVersion, edits: file.edits });
      }
      if (!snapshots.length) return summary;
      if ((options.preview || snapshots.length > 1) && !await requestWorkspaceChangePreview(snapshots)) {
        summary.cancelled = true;
        return summary;
      }
      checkCurrent();
      if (useWorkspaceStore.getState().workspacePath !== workspacePath) throw new Error('The workspace changed; retry');
      const result = await invoke<{ id: string; applied: boolean; recoveryRequired: boolean; error?: string }>('workspace_edit_apply', {
        workspacePath, changes: snapshots.map(({ path, before, after, buffer }) => ({ path, before, after, buffer })),
      });
      if (!result.applied) throw new Error(`${result.error ?? 'Workspace edit failed'}${result.recoveryRequired ? `; recovery required for transaction ${result.id}` : '; changes were rolled back'}`);
      transactionId = result.id;
      checkCurrent();
      if (useWorkspaceStore.getState().workspacePath !== workspacePath) throw new Error('The workspace changed during the edit');
      for (const s of snapshots) if (s.buffer) updateBuffer(monaco, s, s.after);
      await invoke('workspace_edit_complete', { workspacePath, id: result.id, undone: false });
      lastTransaction = { id: result.id, workspacePath, snapshots };
      summary.filesChanged = snapshots.length;
      summary.editsApplied = snapshots.reduce((n, s) => n + s.edits.length, 0);
    } catch (err) {
      let error = err instanceof Error ? err.message : String(err);
      if (transactionId && workspacePath) {
        try {
          await invoke('workspace_edit_undo', { workspacePath, id: transactionId });
          const monaco = getMonacoInstance();
          for (const s of snapshots) {
            const open = useWorkspaceStore.getState().openFiles.find(f => f.path === s.path);
            if (s.buffer && open?.content === s.after) updateBuffer(monaco, s, s.before);
            else if (s.buffer && open?.content !== s.before) throw new Error(`${s.path} changed during rollback; its backup was retained`);
          }
          await invoke('workspace_edit_complete', { workspacePath, id: transactionId, undone: true });
        } catch (recovery) { error += `; recovery required for ${transactionId}: ${String(recovery)}`; }
      }
      summary.failedFiles.push({ path: workspacePath ?? '', error });
      notify.error(`Workspace edit failed: ${error}`);
    }
    return summary;
  });
}

/** One explicit undo includes closed files as well as dirty buffers. It refuses
 * to overwrite subsequent edits; normal per-document undo remains available. */
export function undoLastWorkspaceEdit(): Promise<void> {
  return serialized(async () => {
    const transaction = lastTransaction;
    if (!transaction || transaction.workspacePath !== useWorkspaceStore.getState().workspacePath) throw new Error('No workspace change is available to undo');
    const { id, workspacePath, snapshots } = transaction;
    const openPaths = useWorkspaceStore.getState().openFiles.map(f => f.path);
    const identities = await invoke<Record<string, string>>('workspace_edit_identities', { paths: [...new Set([...snapshots.map(s => s.path), ...openPaths.filter(p => !p.includes('://'))])] });
    const checkBuffers = () => {
      if (useWorkspaceStore.getState().workspacePath !== workspacePath) throw new Error('The workspace changed during undo');
      const current = useWorkspaceStore.getState().openFiles.map(f => f.path);
      if (current.length !== openPaths.length || current.some(p => !openPaths.includes(p))) throw new Error('Open documents changed during undo; review recovery');
      for (const s of snapshots.filter(s => !s.buffer)) {
        if (useWorkspaceStore.getState().openFiles.some(f => (identities[s.path] && identities[f.path] === identities[s.path]) || documentIdentity(f.path) === documentIdentity(s.path))) throw new Error(`Close ${s.path} before undoing this change`);
      }
      for (const s of snapshots.filter(s => s.buffer)) {
        const open = useWorkspaceStore.getState().openFiles.find(f => f.path === s.path);
        if (open?.content !== s.after || (s.model && (s.model.isDisposed() || s.model.getValue() !== s.after))) throw new Error(`${s.path} changed after the operation; undo was stopped`);
      }
    };
    checkBuffers();
    await invoke('workspace_edit_undo', { workspacePath, id });
    checkBuffers();
    for (const s of snapshots) if (s.buffer) updateBuffer(getMonacoInstance(), s, s.before);
    await invoke('workspace_edit_complete', { workspacePath, id, undone: true });
    lastTransaction = null;
  });
}

/** Explicit recovery is previewed, and refuses to overwrite unrelated disk
 * edits. Original dirty buffers are restored as dirty documents, not saved. */
export function reviewWorkspaceRecovery(): Promise<void> {
  return serialized(async () => {
    const workspacePath = useWorkspaceStore.getState().workspacePath;
    if (!workspacePath) throw new Error('Open a workspace first');
    const pending = await invoke<Array<{ id: string; changes: Array<{ path: string; before: string; after: string; buffer: boolean }> }>>('workspace_edit_pending', { workspacePath });
    if (!pending.length) { notify.info('No interrupted workspace changes need recovery.'); return; }
    for (const transaction of pending) {
      if (useWorkspaceStore.getState().workspacePath !== workspacePath) throw new Error('The workspace changed');
      const snapshots: Snapshot[] = [];
      const monaco = getMonacoInstance();
      const identities = await invoke<Record<string, string>>('workspace_edit_identities', { paths: [...new Set([...transaction.changes.map(c => c.path), ...useWorkspaceStore.getState().openFiles.map(f => f.path).filter(p => !p.includes('://'))])] });
      for (const change of transaction.changes) {
        const disk = await invoke<string>('read_file', { path: change.path });
        const aliases = useWorkspaceStore.getState().openFiles.filter(f => (identities[change.path] && identities[f.path] === identities[change.path]) || documentIdentity(f.path) === documentIdentity(change.path));
        if (aliases.length > 1) throw new Error(`Close duplicate views of ${change.path} before recovery`);
        let open = aliases.at(0);
        if (!change.buffer && (open?.isDirty || (disk !== change.before && disk !== change.after))) throw new Error(`${change.path} has subsequent edits; review journal ${transaction.id} before recovering`);
        if (change.buffer && !open) {
          useWorkspaceStore.getState().openFileInBackground(change.path, disk, disk);
          open = useWorkspaceStore.getState().openFiles.find(f => f.path === change.path);
        }
        const model = open && monaco ? findModelForUri(monaco, fileUri(open.path), open.path) : null;
        snapshots.push({ path: open?.path ?? change.path, before: open?.content ?? disk, after: change.before, buffer: !!open,
          model, modelVersion: model?.getVersionId(), documentVersion: getDocumentVersion(open?.path ?? change.path), edits: [] });
      }
      if (!await requestWorkspaceChangePreview(snapshots)) return;
      assertUnchanged(snapshots);
      if (useWorkspaceStore.getState().workspacePath !== workspacePath) throw new Error('The workspace changed');
      await invoke('workspace_edit_undo', { workspacePath, id: transaction.id });
      assertUnchanged(snapshots);
      for (const s of snapshots) if (s.buffer) {
        // Recovery uses full-document snapshots, not the original LSP ranges.
        updateBuffer(monaco, s, s.after, true);
        const wasBuffer = transaction.changes.find(c => documentIdentity(c.path) === documentIdentity(s.path))?.buffer;
        useWorkspaceStore.setState(state => ({ openFiles: state.openFiles.map(f => {
          if (f.path !== s.path) return f;
          const diskContent = wasBuffer ? f.diskContent : s.after;
          return { ...f, diskContent, isDirty: diskContent !== s.after };
        }) }));
      }
      await invoke('workspace_edit_complete', { workspacePath, id: transaction.id, undone: true });
    }
  });
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
    if (summary.cancelled) return { applied: false, failureReason: 'The user cancelled the change preview' };
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
