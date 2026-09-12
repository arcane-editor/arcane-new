// The single path every "open this search match" gesture goes through —
// Enter/Alt+Enter/Cmd+Enter and double-click in the results tab
// (`ExcerptList`), and a row click in the sidebar outline
// (`SearchOutlinePanel`) — so all three land on the same file, cursor
// position AND focus behavior instead of drifting apart.
import { setPendingNavigation } from '../../../utils/editor-navigation';
import { useWorkspaceStore } from '../../../stores/workspace';

/**
 * Opens `filePath` at a real (1-based) `lineNumber`/`column` and moves
 * keyboard focus there.
 *
 * `setPendingNavigation` is set BEFORE `openFile`, not after: it is
 * `EditorPanel`'s `activeFilePath`-keyed effect that actually consumes this
 * (`setPosition` + `revealPositionInCenter` + `focus()`) once the resulting
 * file becomes the active tab — the exact mechanism cross-file Cmd+Click
 * already relies on (`registerEditorOpener` in
 * `features/lsp/services/providers.ts`). Setting it any later risks losing
 * the race against that effect's own read: dispatching a `navigate-to-line`
 * event right after `openFile` (the previous approach here) could fire
 * before the new editor had even mounted, silently dropping the navigation
 * and leaving focus behind in the search tab — which is what the owner saw.
 */
export async function openExcerptAt(
  filePath: string,
  lineNumber: number,
  column: number,
  options: { highlight?: boolean } = {},
): Promise<void> {
  const fileName = filePath.split('/').pop() || '';
  setPendingNavigation({ line: lineNumber, column, highlight: options.highlight });
  await useWorkspaceStore.getState().openFile(filePath, fileName);
}
