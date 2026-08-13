import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
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
      const hidden = applyHiddenAreas(
        editor,
        [{ start: excerpt.startLine, end: excerpt.endLine }],
        model.getLineCount(),
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
      editor?.dispose();
      // The MODEL is not disposed here: eviction and search-tab close own that
      // decision, via the registry. Disposing on unmount would destroy a model
      // another excerpt of the same file is still showing, or one the user is
      // now editing in a tab.
    };
  }, [filePath, excerpt, registry, lineHeight, onFirstEdit, onUnavailable]);

  return (
    <div
      className="search-excerpt-hydrated"
      ref={hostRef}
      style={{ height: `${excerpt.lines.length * lineHeight}px` }}
    />
  );
}

export default HydratedExcerpt;
