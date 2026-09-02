/**
 * The landing cue for a cross-file jump.
 *
 * Navigating to a reference moves the caret and scrolls the view, but with no
 * other feedback the arrival is ambiguous: in a file of similar-looking lines,
 * "did that work, and which line did it mean?" is a real question. A brief
 * highlight answers both without the user reading anything.
 *
 * Deliberately restrained, matching the discipline the rest of this app's
 * motion follows (see App.css: a cue for a transient event fires ONCE and
 * decays; only unresolved state is allowed to loop).
 *
 * A single whole-line decoration carries both the wash and the leading rail,
 * drawn in CSS as background + inset box-shadow. That mirrors
 * `.unity-inspector-line`, and it is deliberate: Monaco's line-decorations
 * gutter is narrow and shared with breakpoints and folding, so a rail placed
 * there renders inconsistently or not at all.
 */

import type { editor as MonacoEditor } from 'monaco-editor';
import type { EditorNavigationTarget } from '../../../utils/editor-navigation';

/** Must outlast the CSS animation in App.css (`nav-landing-wash`). */
const CLEAR_AFTER_MS = 1500;
/** With motion reduced the highlight is static, so it needs to leave sooner. */
const CLEAR_AFTER_MS_REDUCED = 900;

let timer: ReturnType<typeof setTimeout> | null = null;
let collection: MonacoEditor.IEditorDecorationsCollection | null = null;

function clear(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  collection?.clear();
  collection = null;
}

/**
 * Briefly mark `line` as the line just navigated to.
 *
 * Safe to call repeatedly: a second jump clears the first cue rather than
 * stacking decorations, which is what stops a burst of navigations leaving
 * permanently highlighted lines behind.
 */
export function flashNavLanding(
  editor: MonacoEditor.IStandaloneCodeEditor,
  line: number,
): void {
  clear();

  collection = editor.createDecorationsCollection([
    {
      range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
      options: {
        isWholeLine: true,
        className: 'nav-landing-line',
      },
    },
  ]);

  const reduced =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  timer = setTimeout(clear, reduced ? CLEAR_AFTER_MS_REDUCED : CLEAR_AFTER_MS);
}

/** Drop any active cue, e.g. when the editor unmounts. */
export function clearNavLanding(): void {
  clear();
}

/**
 * Move the caret to a pending navigation target, reveal it, and confirm the
 * landing.
 *
 * Shared because EditorPanel consumes a pending navigation from TWO places and
 * they must not drift:
 *
 *   - the `activeFilePath` effect, when Monaco is already mounted and merely
 *     swaps its model, and
 *   - `onMount`, when Monaco had been unmounted entirely.
 *
 * The second case is not an edge case: every structured asset viewer
 * (`InputActionsEditor`, `AssetViewer`, `SceneDiffViewer`) is an early-return
 * render path that unmounts Monaco, so any jump OUT of one of them lands here.
 * When the highlight lived only in the effect, go-to-usage from the Input Hub
 * navigated correctly and never once flashed.
 */
export function applyPendingNavigation(
  editor: MonacoEditor.IStandaloneCodeEditor,
  nav: EditorNavigationTarget,
): void {
  const position = { lineNumber: nav.line, column: nav.column };
  editor.setPosition(position);
  editor.revealPositionInCenter(position);
  if (nav.highlight) flashNavLanding(editor, nav.line);
}
