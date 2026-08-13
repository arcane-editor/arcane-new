import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { editor as MonacoEditorNs, IDisposable } from 'monaco-editor';
import { getMonacoInstance } from '../../../utils/monaco-instance';
import { initMonaco } from '../../editor';
import { fileUri } from '../../lsp';
import { detectLanguage } from '../../../utils/language-detect';
import { applyHiddenAreas } from '../services/hidden-areas';
import type { SearchModelRegistry } from '../services/model-ownership';
import { matchStartPosition, positionWithinExcerpt, type Excerpt } from '../services/excerpt-model';

// Cold rows render at 12px `var(--font-mono)` with a 40px right-aligned
// gutter and no vertical padding (`.search-excerpt-line` /
// `.search-excerpt-gutter`, App.css). Mirrored here the same way
// `ExcerptList`'s `LINE_HEIGHT` mirrors `line-height: 18px`, so a hydrated
// excerpt doesn't visibly change size or x-position relative to the cold
// rows around it as blocks hydrate.
const EXCERPT_FONT_SIZE = 12;
const EXCERPT_GUTTER_WIDTH = 40;

/** Reads the real `--font-mono` value out of the page instead of hardcoding
 *  a guess that can drift from `App.css` — this is the exact stack the cold
 *  rows render with. `undefined` (Monaco's own default) if unavailable,
 *  which only happens outside a browser. */
function excerptFontFamily(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const value = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();
  return value || undefined;
}

interface HydratedExcerptProps {
  filePath: string;
  excerpt: Excerpt;
  registry: SearchModelRegistry;
  lineHeight: number;
  onFirstEdit: (filePath: string, content: string) => void;
  /** Called when this excerpt cannot be hydrated — the internal hidden-areas
   *  API is gone, the range isn't sane against the model, or the backing
   *  model got disposed out from under it. The parent falls back to the
   *  cold render. NOT called merely because Monaco hasn't finished loading
   *  yet — that case retries instead (Task B2). */
  onUnavailable: () => void;
  /** Registers/clears this excerpt's live editor instance with the list, so
   *  `openActiveExcerpt` (Enter/alt+Enter) can read its real cursor position
   *  instead of a caret probe. See `ExcerptList`. */
  onEditorMount: (excerptId: string, editorInstance: MonacoEditorNs.IStandaloneCodeEditor) => void;
  onEditorUnmount: (excerptId: string) => void;
  /** Opens `filePath` at a real (1-based) line/column. Wired to a Monaco
   *  action bound to Alt+Enter (NOT plain Enter — that still means "insert
   *  a newline" inside a live editor) on this excerpt's own editor — see
   *  the `addAction` call below for why that, and not the results list's
   *  own keydown handler, has to be the one to own this now. */
  onOpenExcerpt: (filePath: string, lineNumber: number, column: number) => void;
}

function HydratedExcerpt({
  filePath,
  excerpt,
  registry,
  lineHeight,
  onFirstEdit,
  onUnavailable,
  onEditorMount,
  onEditorUnmount,
  onOpenExcerpt,
}: HydratedExcerptProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Best guess before Monaco exists to measure anything; synced to Monaco's
  // own content height once it does, and kept in sync as the user types
  // (Task B4 — see the comment at the `onDidContentSizeChange` subscription
  // below for why a frozen height is actively wrong, not just cosmetic).
  const [height, setHeight] = useState(() => excerpt.lines.length * lineHeight);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      onUnavailable();
      return;
    }

    let disposed = false;
    let editor: MonacoEditorNs.IStandaloneCodeEditor | null = null;
    let modelDisposeListener: IDisposable | null = null;
    let contentSizeListener: IDisposable | null = null;
    let openAction: IDisposable | null = null;

    async function mount() {
      // `main.tsx` kicks off `initMonaco()` fire-and-forget so first paint
      // isn't blocked on it — a session restored straight onto a search tab
      // mounts every visible excerpt before Monaco is necessarily ready.
      // That is "not ready YET", not "can't be hydrated": await the same
      // singleton loader (idempotent — resolves to the in-flight or
      // already-created instance) instead of latching cold forever.
      let monaco = getMonacoInstance();
      if (!monaco) {
        monaco = await initMonaco().catch(() => null);
        if (disposed) return;
      }
      if (!monaco) {
        onUnavailable();
        return;
      }

      const uri = monaco.Uri.parse(fileUri(filePath));
      let model = monaco.editor.getModel(uri);
      if (!model) {
        // No tab backs this file, so search creates the model and owns it.
        // Re-check after the await: another excerpt of the same file may have
        // created it while this read was in flight.
        const content = await invoke<string>('read_file', { path: filePath });
        if (disposed) return;
        const existing = monaco.editor.getModel(uri);
        if (existing) {
          model = existing;
        } else {
          model = monaco.editor.createModel(content, detectLanguage(filePath).monacoId, uri);
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

      editor = monaco.editor.create(host!, {
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
        // Match the cold row this editor replaces (`.search-excerpt-line` /
        // `.search-excerpt-gutter`, App.css) so nothing visibly jumps in
        // size or x-position as blocks hydrate. The editor's own theme
        // background is overridden transparent in App.css
        // (`.search-excerpt-hydrated`) so it sits on the list's surface
        // instead of painting a different background per excerpt.
        fontSize: EXCERPT_FONT_SIZE,
        fontFamily: excerptFontFamily(),
        lineDecorationsWidth: EXCERPT_GUTTER_WIDTH,
        padding: { top: 0, bottom: 0 },
      });

      // One excerpt, so one visible range: everything else in the file hides.
      //
      // Guard the range before handing it to Monaco. `complementRanges`
      // assumes `startLine <= endLine <= lineCount`; break that and the
      // "visible" line can escape BOTH emitted hidden ranges: `startLine >
      // endLine` makes `{1,S-1}` and `{E+1,L}` overlap and merge into full
      // coverage, and `startLine > lineCount` clamps `{1,S-1}` to `{1,L}`
      // with no second range pushed at all. Neither shape is producible by
      // `buildExcerpts` against the model IT scanned, but this component can
      // end up hydrating a DIFFERENT model than the one that was scanned: a
      // tab's model with unsaved deletions (shorter than `startLine`), or a
      // file truncated on disk between the search scan and this (lazily
      // virtualized) block actually scrolling into view and hydrating. Either
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

      onEditorMount(excerpt.id, editor);

      // Clicking a result IS clicking into Monaco — mousedown bubbles up to
      // `FileExcerptBlock`'s `onFocusExcerpt`, but focus itself lands in
      // THIS editor, not the results list's container. `ExcerptList`'s own
      // keydown handler deliberately ignores every key that originates
      // inside a hydrated excerpt (Task A1, so typing survives), which means
      // Alt+Enter reaching this editor previously had nothing bound to it
      // and did nothing — no keyboard route to "open the file" existed once
      // focus was inside a hydrated excerpt, which is the ordinary case.
      // This editor now owns that gesture directly: open at the real cursor
      // when it's inside this excerpt's visible range, else fall back to
      // the match start — a freshly re-hydrated editor that was never
      // actually clicked into (switching to a file tab and back preserves
      // `activeExcerptId` across the remount) defaults its cursor to the
      // model's (1,1), which is usually outside the excerpt.
      //
      // PLAIN Enter is deliberately NOT bound here, unlike the list's own
      // handler. Inside a live editor, `editorTextFocus` (needed so this
      // doesn't compete with a widget's own Enter — see below) is true
      // exactly while the user is TYPING, so binding plain Enter here would
      // turn every newline into a navigation away from the excerpt — the
      // exact defect A1 exists to prevent, since the whole point of this
      // feature is that a result is directly editable. The list's container
      // and a live editor have different correct answers for the same key:
      // outside a hydrated excerpt (a cold block, or focus on the bare
      // container) plain Enter still opens, unchanged, in
      // `ExcerptList.openActiveExcerpt`; inside one, only Alt+Enter does —
      // matching Zed's `editor::OpenExcerpts` binding and this feature's own
      // spec. Do not add plain Enter back here for symmetry with the list.
      //
      // `precondition: 'editorTextFocus'` scopes this to the PLAIN text
      // area: Monaco's own widgets (rename confirm, suggest accept, find
      // navigate) take focus off the text area onto their own input while
      // open, so this deliberately does not compete with their own
      // (correct) Enter handling — a dynamically added action's keybinding
      // outranks every one of those by weight otherwise.
      openAction = editor.addAction({
        id: 'search-excerpt.open-at-cursor',
        label: 'Open File at Cursor',
        precondition: 'editorTextFocus',
        keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.Enter],
        run: (ed) => {
          const position = ed.getPosition();
          const target =
            position && positionWithinExcerpt(excerpt, position.lineNumber)
              ? { lineNumber: position.lineNumber, column: position.column }
              : matchStartPosition(excerpt);
          if (target) onOpenExcerpt(filePath, target.lineNumber, target.column);
        },
      });

      // Sync the host to Monaco's own measurement immediately, then keep
      // syncing. The scrollbar is hidden and wheel is disabled (the results
      // list owns scrolling), but Monaco still scrolls PROGRAMMATICALLY to
      // keep the cursor in view — with a host frozen at the React-estimated
      // height, pressing Enter on the last visible line scrolls the
      // excerpt's own FIRST line out of the fixed window, silently showing
      // the wrong lines rather than merely hiding the new one.
      setHeight(editor.getContentHeight());
      contentSizeListener = editor.onDidContentSizeChange(() => {
        setHeight(editor!.getContentHeight());
      });

      editor.onDidChangeModelContent(() => {
        // Fires for every writer of this model, and every excerpt of this
        // file has its own listener on the SAME shared model — without this
        // guard, one keystroke fires `onFirstEdit` (and its full-text
        // `didChange` notification to csharp-ls) once per excerpt of the
        // file instead of once. `hasWidgetFocus`, not `hasTextFocus`: a
        // rename (F2) or code action applied inside this excerpt mutates the
        // model while ITS OWN widget (the rename input, a peek view) holds
        // DOM focus, not the text area — `hasTextFocus` would be false for
        // an edit that is unambiguously this editor's own, silently
        // dropping it (never opens the background tab, never enters
        // `editedPaths`, and the model — still search-owned — gets disposed
        // on the next eviction with no error). `hasWidgetFocus` covers both
        // the text area and this editor's own widgets, while still being
        // false for every OTHER excerpt's editor on the same shared model —
        // which is all the dedup above actually needs.
        if (!editor!.hasWidgetFocus()) return;
        onFirstEdit(filePath, model!.getValue());
      });
    }

    void mount();

    return () => {
      disposed = true;
      contentSizeListener?.dispose();
      openAction?.dispose();
      modelDisposeListener?.dispose();
      if (editor) onEditorUnmount(excerpt.id);
      editor?.dispose();
      // The MODEL is not disposed here: eviction and search-tab close own that
      // decision, via the registry. Disposing on unmount would destroy a model
      // another excerpt of the same file is still showing, or one the user is
      // now editing in a tab.
    };
    // `excerpt` itself is deliberately NOT a dependency: `ExcerptList`
    // rebuilds every excerpt object on every render (streaming batches
    // replacing `session.results`, or a file block's collapsed state
    // toggling elsewhere in the list), so depending on the object identity
    // would tear down and remount every mounted editor on unrelated churn
    // elsewhere in the results list — losing cursor/selection on every
    // keystroke of a streaming search. Only the primitives this effect
    // actually reads off `excerpt` are listed, so a re-render that produces
    // an equivalent excerpt (same lines, same range) does not remount the
    // editor.
  }, [
    filePath,
    excerpt.id,
    excerpt.startLine,
    excerpt.endLine,
    registry,
    lineHeight,
    onFirstEdit,
    onUnavailable,
    onEditorMount,
    onEditorUnmount,
    onOpenExcerpt,
  ]);

  return <div className="search-excerpt-hydrated" ref={hostRef} style={{ height: `${height}px` }} />;
}

export default HydratedExcerpt;
