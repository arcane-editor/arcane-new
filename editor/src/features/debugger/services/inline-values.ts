import type { Monaco } from '@monaco-editor/react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { useDebugStore } from '../../../stores/debug';
import { inlineHints } from './inline-value-hints';
import { useSettingsStore } from '../../../stores/settings';
import { pathFromFileUri } from '../../../utils/file-uri';

/**
 * Values shown at the end of the lines they appear on, while paused.
 *
 * This is the thing people miss most from Rider: the values are simply there,
 * next to the code, instead of behind a hover or in a pane you have to look
 * across at.
 *
 * Built on `after:` decorations, the same mechanism as the git inline blame,
 * which already solved the hard parts — a settle so it does not flicker while
 * stepping, and dropping the hints the moment the buffer is edited, because a
 * dirty buffer means the line numbers no longer describe the running code.
 */

/**
 * Attach inline values to an editor. Returns a disposer.
 */
export function attachInlineValues(
  editor: MonacoEditor.IStandaloneCodeEditor,
  monaco: Monaco,
): () => void {
  const collection = editor.createDecorationsCollection();
  // The buffer version the hints were computed against. Once the user types,
  // the line numbers stop describing the code that is actually running.
  let baseline: number | null = null;

  const enabled = () =>
    useSettingsStore.getState().getSetting('debug.inlineValues') !== false;

  const render = () => {
    try {
      const model = editor.getModel();
      const state = useDebugStore.getState();
      if (!model || !enabled() || state.status !== 'paused') {
        collection.clear();
        return;
      }

      const frame = state.frames.find((f) => f.id === state.currentFrameId);
      const uri = model.uri.toString();
      const path = uri.startsWith('file://') ? pathFromFileUri(uri) : null;
      if (!frame?.path || !path || !samePath(frame.path, path)) {
        collection.clear();
        return;
      }

      // Only the eagerly loaded Locals scope: expanding an object to annotate
      // its fields would mean a round trip per line.
      const scope = state.scopes[0];
      const variables = scope ? state.variables.get(scope.variablesReference) ?? [] : [];

      baseline = model.getAlternativeVersionId();
      const hints = inlineHints(model.getLinesContent(), variables, frame.line);
      collection.set(
        hints.map((hint) => ({
          range: new monaco.Range(
            hint.line,
            model.getLineMaxColumn(hint.line),
            hint.line,
            model.getLineMaxColumn(hint.line),
          ),
          options: {
            after: { content: `   ${hint.text}`, inlineClassName: 'dbg-inline-value' },
            showIfCollapsed: true,
          },
        })),
      );
    } catch (err) {
      // The debugger stays a non-load-bearing layer: a failure here must not
      // take the editor with it.
      console.error('[debugger] inline values failed (non-fatal):', err);
      collection.clear();
    }
  };

  const unsubscribe = useDebugStore.subscribe(render);
  const onModel = editor.onDidChangeModel(render);
  const onContent = editor.onDidChangeModelContent(() => {
    const model = editor.getModel();
    // Values describe the code that was compiled, not the code on screen.
    if (baseline !== null && model && model.getAlternativeVersionId() !== baseline) {
      collection.clear();
    }
  });
  render();

  return () => {
    unsubscribe();
    onModel.dispose();
    onContent.dispose();
    collection.clear();
  };
}

function samePath(a: string, b: string): boolean {
  const normalize = (p: string) => {
    const forward = p.replace(/\\/g, '/');
    return /^[A-Za-z]:\//.test(forward) ? forward.toLowerCase() : forward;
  };
  return normalize(a) === normalize(b);
}
