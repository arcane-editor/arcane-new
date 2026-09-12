import type { Monaco } from '@monaco-editor/react';
import type { editor as MonacoEditorNs, IDisposable } from 'monaco-editor';
import { useGitStore } from '../../../stores/git';
import { useWorkspaceStore } from '../../../stores/workspace';
import {
  blamePadding,
  formatBlameHover,
  formatInlineBlame,
  shouldShowBlame,
} from './blame-format';

/** Zed's `delay_ms`. Long enough to survive a held arrow key. */
const SETTLE_MS = 220;

function pathFromUri(uri: string): string | null {
  if (!uri.startsWith('file://')) return null;
  try {
    return decodeURIComponent(uri.slice('file://'.length));
  } catch {
    return null;
  }
}

/**
 * Git blame, on the line the cursor is on — the treatment Zed uses.
 *
 * This used to be a Monaco *hover provider*, which is what made it awkward.
 * Blame is a property of a LINE, but a hover provider answers a question about
 * a SYMBOL: hovering `transform` to find out what it is returned the language
 * server's signature, the Unity docs, the usage count AND whoever last touched
 * that line, stacked into one popover. Blame was never what you asked for, and
 * it was in the way of what you did ask for. Worse, hovering was the ONLY way
 * to see it — there was nothing to read while simply reading.
 *
 * Inline instead: a dim run of text after the end of the cursor's line, which
 * is legible at rest and costs nothing when you are not looking at it.
 * Hovering that text — and only that text — opens the full commit.
 *
 * Deliberately mirrors the shape of Zed's `git.inline_blame`: cursor line
 * only, a short settle delay so it does not strobe while you hold an arrow
 * key, padding before the hint, and a minimum column so a short line does not
 * park it against the code.
 */

export function attachInlineBlame(
  editor: MonacoEditorNs.IStandaloneCodeEditor,
  _monaco: Monaco,
): () => void {
  let collection = editor.createDecorationsCollection([]);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  /**
   * The document version the cached blame describes. Once the buffer is dirty
   * its line numbers no longer line up with what git blamed, so the hint would
   * confidently attribute the wrong commit — showing nothing is the honest
   * answer until a save re-runs blame.
   */
  let baselineVersionId = editor.getModel()?.getAlternativeVersionId() ?? 0;

  const clear = () => collection.set([]);

  const render = () => {
    if (disposed) return;
    const model = editor.getModel();
    const position = editor.getPosition();
    if (!model || !position) return clear();

    // A selection is an edit in progress, not a read.
    const selection = editor.getSelection();
    if (selection && !selection.isEmpty()) return clear();

    const ws = useWorkspaceStore.getState().workspacePath;
    const git = useGitStore.getState();
    if (!ws || !git.isGitRepo) return clear();
    // Blaming a generated 50k-line file costs more than it tells anyone.
    if (model.getLineCount() > 50_000) return clear();

    const absPath = pathFromUri(model.uri.toString());
    if (!absPath || (!absPath.startsWith(`${ws}/`) && absPath !== ws)) return clear();

    if (model.getAlternativeVersionId() !== baselineVersionId) return clear();

    const cached = git.blameCache.get(absPath);
    if (!cached || cached.gen !== git.blameGen) {
      // Fetches once and caches; the store dedupes concurrent callers. The
      // store subscription below is what paints the result when it lands.
      git.getBlame(ws, absPath);
      return clear();
    }

    const line = cached.lines[position.lineNumber - 1];
    if (!line) return clear();

    const content = model.getLineContent(position.lineNumber);
    if (!shouldShowBlame(content)) return clear();

    const endColumn = model.getLineMaxColumn(position.lineNumber);
    collection.set([
      {
        range: {
          startLineNumber: position.lineNumber,
          startColumn: endColumn,
          endLineNumber: position.lineNumber,
          endColumn,
        },
        options: {
          after: {
            content: formatInlineBlame(line),
            inlineClassName: 'inline-blame',
          },
          hoverMessage: { value: formatBlameHover(line), isTrusted: false },
        },
      },
    ]);

    // The gap is per-line, so it cannot live in the stylesheet.
    editor.getContainerDomNode().style.setProperty(
      '--inline-blame-pad',
      `${blamePadding(content.length)}ch`,
    );
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    // Cleared immediately rather than on the timer: a stale attribution left
    // sitting under a cursor that has already moved is worse than a 220ms gap.
    clear();
    timer = setTimeout(render, SETTLE_MS);
  };

  const subs: IDisposable[] = [
    editor.onDidChangeCursorPosition(schedule),
    editor.onDidChangeModelContent(schedule),
    editor.onDidChangeModel(() => {
      collection.clear();
      collection = editor.createDecorationsCollection([]);
      baselineVersionId = editor.getModel()?.getAlternativeVersionId() ?? 0;
      schedule();
    }),
    editor.onDidBlurEditorText(clear),
  ];

  // Blame arrives asynchronously. Without this the first paint after a fetch
  // would have to wait for the next cursor move.
  const unsubscribeStore = useGitStore.subscribe(schedule);

  schedule();

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    unsubscribeStore();
    subs.forEach((s) => s.dispose());
    collection.clear();
  };
}
