import type { Monaco } from '@monaco-editor/react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { useDebugStore } from '../../../stores/debug';
import { useSettingsStore } from '../../../stores/settings';
import { useProjectContextStore } from '../../../stores/project-context';

/**
 * Wires Monaco's glyph margin to the debug store: click the margin to toggle a
 * breakpoint, and render breakpoint glyphs + the current paused line. Attached
 * once per mounted editor (the editor swaps models per tab, so we re-render on
 * model change). No-op for non-Unity projects or when debugging is disabled.
 */
function modelFilePath(model: MonacoEditor.ITextModel | null): string | null {
  if (!model) return null;
  const uri = model.uri.toString();
  if (!uri.startsWith('file://')) return null;
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}

export function attachBreakpointGutter(
  editor: MonacoEditor.IStandaloneCodeEditor,
  monaco: Monaco,
): void {
  // Defensive: this runs from Monaco's onMount for EVERY editor (any project).
  // A throw here would break editor mounting, so the whole attach is guarded
  // and the debugger stays a non-load-bearing layer.
  try {
    attachBreakpointGutterUnsafe(editor, monaco);
  } catch (err) {
    console.error('[debugger] breakpoint gutter attach failed (non-fatal):', err);
  }
}

function attachBreakpointGutterUnsafe(
  editor: MonacoEditor.IStandaloneCodeEditor,
  monaco: Monaco,
): void {
  const enabled = () =>
    useProjectContextStore.getState().isUnityProject &&
    useSettingsStore.getState().getSetting('unity.debugger.enabled') !== false;

  const collection = editor.createDecorationsCollection();

  const render = () => {
    try {
      renderDecorations();
    } catch (err) {
      console.error('[debugger] breakpoint render failed (non-fatal):', err);
    }
  };

  const renderDecorations = () => {
    const model = editor.getModel();
    const file = modelFilePath(model);
    if (!file || !enabled()) {
      collection.clear();
      return;
    }
    const decos: MonacoEditor.IModelDeltaDecoration[] = [];
    for (const bp of useDebugStore.getState().breakpointsFor(file)) {
      decos.push({
        range: new monaco.Range(bp.line, 1, bp.line, 1),
        options: {
          isWholeLine: false,
          glyphMarginClassName: bp.condition ? 'dbg-breakpoint dbg-breakpoint--conditional' : 'dbg-breakpoint',
          glyphMarginHoverMessage: { value: bp.condition ? `Conditional breakpoint: \`${bp.condition}\`` : 'Breakpoint' },
        },
      });
    }
    // Highlight the current paused line (top frame in this file).
    const { status, frames, currentFrameId } = useDebugStore.getState();
    if (status === 'paused') {
      const frame = frames.find((f) => f.id === currentFrameId) ?? frames[0];
      if (frame?.path && modelFilePath(model) === frame.path) {
        decos.push({
          range: new monaco.Range(frame.line, 1, frame.line, 1),
          options: { isWholeLine: true, className: 'dbg-current-line', glyphMarginClassName: 'dbg-current-arrow' },
        });
      }
    }
    collection.set(decos);
  };

  // Toggle on glyph-margin click.
  const clickDisposable = editor.onMouseDown((e) => {
    if (!enabled()) return;
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    const line = e.target.position?.lineNumber;
    const file = modelFilePath(editor.getModel());
    if (line == null || !file) return;
    useDebugStore.getState().toggleBreakpoint(file, line);
  });

  const modelDisposable = editor.onDidChangeModel(() => render());
  const unsub = useDebugStore.subscribe(render);
  render();

  editor.onDidDispose(() => {
    clickDisposable.dispose();
    modelDisposable.dispose();
    unsub();
  });
}
