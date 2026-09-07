/**
 * Drives a Find Usages query from wherever the caret happens to be.
 *
 * There is no "active editor" accessor in this codebase — Monaco's own registry
 * is the source of truth — so this resolves the focused editor the same way
 * `selectionSeedQuery` in App.tsx does.
 */

import { getMonacoInstance } from '../../../utils/monaco-instance';
import { queryReferences, NoLanguageServerError } from '../../lsp';
import { useReferencesStore } from '../../../stores/references';
import { useUiStore } from '../../../stores/ui';

/** True when a symbol is under the caret and something could answer for it. */
export function canFindUsages(): boolean {
  const monaco = getMonacoInstance();
  const editor = (monaco?.editor.getEditors() ?? []).find((e) => e.hasTextFocus());
  const position = editor?.getPosition();
  const model = editor?.getModel();
  if (!position || !model) return false;
  return !!model.getWordAtPosition(position);
}

export async function findUsagesAtCursor(): Promise<void> {
  const monaco = getMonacoInstance();
  const editors = monaco?.editor.getEditors() ?? [];
  const editor = editors.find((e) => e.hasTextFocus()) ?? editors[0];
  const position = editor?.getPosition();
  const model = editor?.getModel();
  if (!editor || !position || !model) return;

  const word = model.getWordAtPosition(position)?.word;
  if (!word) return;

  const token = useReferencesStore.getState().begin(word);

  // Show the panel before the query returns: on a large solution this takes a
  // moment, and a chord that appears to do nothing reads as broken.
  const ui = useUiStore.getState();
  ui.setActiveBottomTab('references');
  ui.setBottomPanelVisible(true);

  try {
    const hits = await queryReferences(model, position);
    // null means the request was cancelled by a newer one; leave the panel as
    // the newer query left it rather than blanking it.
    if (hits === null) return;
    await useReferencesStore.getState().showResults(token, word, hits);
  } catch (err) {
    const message =
      err instanceof NoLanguageServerError
        ? `No language server is running for this file, so usages of “${word}” cannot be found.`
        : `Could not find usages of “${word}”: ${err instanceof Error ? err.message : String(err)}`;
    useReferencesStore.getState().fail(token, word, message);
  }
}
