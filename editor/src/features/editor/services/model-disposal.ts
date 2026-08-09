import { fileUri } from '../../lsp';
import { getMonaco } from './monaco-init';

/**
 * Dispose the Monaco text model backing `path`, if one exists.
 *
 * Monaco keeps a model alive after the component that rendered it unmounts —
 * closing a tab does not free it. Two things went wrong as a result:
 *
 * 1. **Discarded edits could be written back to disk.** Close a file with
 *    unsaved changes and choose "Close Anyway", and the orphaned model still
 *    holds those changes. A later project-wide LSP rename or quick-fix that
 *    touches the same file finds that model via `findModelForUri`, applies the
 *    edit to it, sees no open tab, and writes the *entire orphan buffer* to
 *    disk. The file becomes the version the user explicitly threw away — and
 *    anything Unity, git, or another editor wrote to it in the meantime is
 *    overwritten too.
 *
 * 2. **Memory grew for the session.** Browsing a large Unity codebase
 *    accumulated a model per file opened, never released, even with every tab
 *    closed.
 *
 * Must be called *after* the LSP `didClose` notification: the server should be
 * told the document closed while it still exists.
 */
export function disposeModelForPath(path: string): void {
  const monaco = getMonaco();
  if (!monaco) return;
  // Virtual tabs (`diff://`, `auth://`) never had a file-backed model.
  if (path.includes('://')) return;

  const model = monaco.editor.getModel(monaco.Uri.parse(fileUri(path)));
  model?.dispose();
}
