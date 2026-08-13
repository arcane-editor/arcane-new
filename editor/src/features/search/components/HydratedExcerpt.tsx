import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { IDisposable } from 'monaco-editor';
import { getMonacoInstance } from '../../../utils/monaco-instance';
import { fileUri } from '../../lsp';
import { detectLanguage } from '../../../utils/language-detect';
import { applyHiddenAreas } from '../services/hidden-areas';
import type { SearchModelRegistry } from '../services/model-ownership';
import type { Excerpt } from '../services/excerpt-model';

interface HydratedExcerptProps {
  filePath: string;
  excerpt: Excerpt;
  registry: SearchModelRegistry;
  lineHeight: number;
  onFirstEdit: (filePath: string, content: string) => void;
  /** Called when this excerpt cannot be hydrated — no Monaco, or the internal
   *  hidden-areas API is gone. The parent falls back to the cold render. */
  onUnavailable: () => void;
}

function HydratedExcerpt({
  filePath,
  excerpt,
  registry,
  lineHeight,
  onFirstEdit,
  onUnavailable,
}: HydratedExcerptProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const monaco = getMonacoInstance();
    const host = hostRef.current;
    if (!monaco || !host) {
      onUnavailable();
      return;
    }

    let disposed = false;
    let editor: ReturnType<typeof monaco.editor.create> | null = null;
    let modelDisposeListener: IDisposable | null = null;

    async function mount() {
      const uri = monaco!.Uri.parse(fileUri(filePath));
      let model = monaco!.editor.getModel(uri);
      if (!model) {
        // No tab backs this file, so search creates the model and owns it.
        // Re-check after the await: another excerpt of the same file may have
        // created it while this read was in flight.
        const content = await invoke<string>('read_file', { path: filePath });
        if (disposed) return;
        const existing = monaco!.editor.getModel(uri);
        if (existing) {
          model = existing;
        } else {
          model = monaco!.editor.createModel(content, detectLanguage(filePath).monacoId, uri);
          registry.claim(filePath);
        }
      }
      if (disposed) return;

      // A background tab (the first edit into a file with no tab yet opens
      // one — see `ExcerptList.onFirstEdit`) or a real editor tab can close
      // and dispose this exact model out from under this excerpt at any
      // time — `stores/workspace.ts`'s `closeFile` does. Before this
      // feature existed only the active tab's editor ever touched a model,
      // so that was safe; now a hydrated excerpt can be bound to a model a
      // background tab owns. Drop to the cold render instead of letting the
      // next layout pass or keystroke throw against a disposed model.
      modelDisposeListener = model.onWillDispose(() => {
        onUnavailable();
      });

      editor = monaco!.editor.create(host!, {
        model,
        lineNumbers: 'on',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        overviewRulerLanes: 0,
        overviewRulerBorder: false,
        hideCursorInOverviewRuler: true,
        folding: false,
        glyphMargin: false,
        renderLineHighlight: 'none',
        // The results list owns vertical scrolling; an inner scrollbar here
        // would trap the wheel over every excerpt.
        scrollbar: { vertical: 'hidden', horizontal: 'auto', handleMouseWheel: false },
        automaticLayout: true,
        lineHeight,
      });

      // One excerpt, so one visible range: everything else in the file hides.
      //
      // Guard the range before handing it to Monaco. `complementRanges`
      // assumes `startLine <= endLine <= lineCount`; break that and the
      // "visible" line can escape BOTH emitted hidden ranges: `startLine >
      // endLine` makes `{1,S-1}` and `{E+1,L}` overlap and merge into full
      // coverage, and `startLine > lineCount` clamps `{1,S-1}` to `{1,L}`
      // with no second range pushed at all. Neither shape is producible by
      // `buildExcerpts`/`applyExpansion` against the model THEY scanned, but
      // this component can end up hydrating a DIFFERENT model than the one
      // that was scanned: a tab's model with unsaved deletions (shorter than
      // `startLine`), or a file truncated on disk between the search scan
      // and an `expand` click clamping `endLine` under `startLine`. Either
      // shape then hits Monaco's own `!hasVisibleLine` fallback
      // (viewModelLines.js, ViewModelLinesFromProjectedModel.setHiddenAreas)
      // which SILENTLY REVEALS THE ENTIRE FILE instead of erroring —
      // `applyHiddenAreas` still returns true, since Monaco's API was
      // present the whole time. Treat a bad range exactly like the
      // unavailable-API case, before it ever reaches Monaco.
      const lineCount = model.getLineCount();
      const rangeIsSane =
        excerpt.startLine >= 1 &&
        excerpt.startLine <= excerpt.endLine &&
        excerpt.startLine <= lineCount;
      if (!rangeIsSane) {
        editor.dispose();
        editor = null;
        onUnavailable();
        return;
      }

      const hidden = applyHiddenAreas(
        editor,
        [{ start: excerpt.startLine, end: excerpt.endLine }],
        lineCount,
      );
      if (!hidden) {
        // Without hidden areas this editor would show the entire file inside a
        // few rows of space. Tear it down and let the parent render cold.
        editor.dispose();
        editor = null;
        onUnavailable();
        return;
      }

      editor.onDidChangeModelContent(() => {
        onFirstEdit(filePath, model!.getValue());
      });
    }

    void mount();

    return () => {
      disposed = true;
      modelDisposeListener?.dispose();
      editor?.dispose();
      // The MODEL is not disposed here: eviction and search-tab close own that
      // decision, via the registry. Disposing on unmount would destroy a model
      // another excerpt of the same file is still showing, or one the user is
      // now editing in a tab.
    };
    // `excerpt` itself is deliberately NOT a dependency: `ExcerptList`
    // rebuilds every excerpt object on every render (streaming batches,
    // expand/collapse anywhere in the list, `fileLines` updates), so
    // depending on the object identity would tear down and remount every
    // mounted editor on unrelated churn elsewhere in the results list —
    // losing cursor/selection on every keystroke of a streaming search. Only
    // the primitives this effect actually reads off `excerpt` are listed, so
    // a re-render that produces an equivalent excerpt (same lines, same
    // range) does not remount the editor.
  }, [filePath, excerpt.startLine, excerpt.endLine, registry, lineHeight, onFirstEdit, onUnavailable]);

  return (
    <div
      className="search-excerpt-hydrated"
      ref={hostRef}
      style={{ height: `${excerpt.lines.length * lineHeight}px` }}
    />
  );
}

export default HydratedExcerpt;
