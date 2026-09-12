import type { editor } from 'monaco-editor';
import { getMonacoInstance } from './monaco-instance';
import { fileUri } from './file-uri';

const pending = new Map<string, editor.ICodeEditorViewState>();
export function captureRenamedView(oldPath: string, newPath: string): void {
  const monaco = getMonacoInstance();
  if (!monaco) return;
  const model = monaco.editor.getModel(monaco.Uri.parse(fileUri(oldPath)));
  const view = monaco.editor.getEditors().find((e) => e.getModel() === model)?.saveViewState();
  if (view) pending.set(newPath, view);
}
export function restoreRenamedView(instance: editor.ICodeEditor, path: string): void {
  const view = pending.get(path);
  if (view) { pending.delete(path); instance.restoreViewState(view); }
}
export function forgetRenamedView(path: string): void { pending.delete(path); }
