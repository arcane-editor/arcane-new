import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronUp } from 'lucide-react';
import { getFileIcon } from '../../../utils/file-icons';
import { detectLanguage } from '../../../utils/language-detect';
import { getMonacoInstance } from '../../../utils/monaco-instance';
import { useThemeStore } from '../../../stores/theme';
import { splitByMatches, stripTrailingBreak } from '../services/highlight';
import { offsetWithinLine, columnFor } from '../services/caret-offset';
import type { Excerpt, MatchRange } from '../services/excerpt-model';
import type { SearchModelRegistry } from '../services/model-ownership';
import HydratedExcerpt from './HydratedExcerpt';
import { LINE_HEIGHT } from './ExcerptList';

interface FileExcerptBlockProps {
  filePath: string;
  relativePath: string;
  excerpts: Excerpt[];
  matchCount: number;
  collapsed: boolean;
  activeExcerptId: string | null;
  onToggleCollapse: (filePath: string) => void;
  onOpenExcerpt: (filePath: string, lineNumber: number, column: number) => void;
  onFocusExcerpt: (excerptId: string) => void;
  onExpand: (excerptId: string, direction: 'up' | 'down') => void;
  /** Excerpt ids to render as live Monaco editors instead of the plain
   *  read-only rows. Every excerpt of a hot file is hot — see `ExcerptList`. */
  hotExcerptIds: string[];
  registry: SearchModelRegistry;
  onFirstEdit: (filePath: string, content: string) => void;
}

/** Colorized HTML per (themeId, languageId, text). Search results repeat
 *  lines across excerpts constantly, and colorize is an async tokenizer
 *  pass, so without a cache scrolling re-tokenizes the same lines on every
 *  virtualization pass. Values are stored already stripped of Monaco's
 *  trailing `<br/>` (see `stripTrailingBreak`), so every reader gets clean
 *  HTML for free.
 *
 *  Keyed on `themeId` too, not just `(monacoId, text)`: `colorize()` emits
 *  `mtkN` CSS classes, and Monaco regenerates what colour each `mtkN` maps to
 *  per theme — the class names themselves don't change when the theme
 *  switches, only the stylesheet behind them. Without the theme in the key,
 *  a line colourized under the old theme and a line colourized fresh under
 *  the new one would sit on screen together, one still resolving its
 *  `mtkN` classes to the OLD theme's palette. */
const colorCache = new Map<string, string>();

interface ColorizedResult {
  /** The (themeId, monacoId, text) key this HTML was actually computed for. */
  key: string;
  html: string;
}

function useColorizedLine(text: string, monacoId: string, themeId: string): string | null {
  const key = `${themeId} ${monacoId} ${text}`;
  const [result, setResult] = useState<ColorizedResult | null>(() => {
    const cached = colorCache.get(key);
    return cached === undefined ? null : { key, html: cached };
  });

  useEffect(() => {
    const cached = colorCache.get(key);
    if (cached !== undefined) {
      setResult({ key, html: cached });
      return;
    }
    // Go through the lazily-initialized singleton, not a static `import * as
    // monaco from 'monaco-editor'` — that package runs browser-only code
    // (`window.location`, animation-frame scheduling) at module-eval time,
    // and this component is reachable from the feature barrel that
    // `stores/search.ts` imports, so a static value import here crashes any
    // bun-test process that loads that barrel without a DOM (as
    // `search-tab-lifecycle.exec.ts` does). If Monaco hasn't initialized yet,
    // plain text is a fine result — same fallback as a tokenizer error below.
    const monacoInstance = getMonacoInstance();
    if (!monacoInstance) return;
    let cancelled = false;
    monacoInstance.editor
      .colorize(text, monacoId, { tabSize: 4 })
      .then((raw) => {
        const html = stripTrailingBreak(raw);
        if (colorCache.size > 5000) colorCache.clear();
        colorCache.set(key, html);
        if (!cancelled) setResult({ key, html });
      })
      .catch(() => {
        // Unknown language or a tokenizer error: plain text is a fine result.
      });
    return () => {
      cancelled = true;
    };
  }, [text, monacoId, themeId, key]);

  // `result` may still hold the PREVIOUS (text, monacoId) pair's HTML: the
  // `cancelled` flag above only prevents a stale async write from landing —
  // it does nothing about a stale READ of state nobody has updated yet. A
  // row whose `text` prop changes while Monaco is unavailable (the effect
  // above returns immediately, before ever calling `setResult`) would
  // otherwise go on rendering the OLD text's colorized HTML forever. Only
  // hand back HTML that was actually computed for the CURRENT key.
  return result?.key === key ? result.html : null;
}

/** Character offset within `lineEl`'s text for a viewport point, or null when
 *  the browser exposes neither caret API or reports a node outside the line.
 *  Callers fall back to the match start. */
function offsetFromPoint(lineEl: HTMLElement, x: number, y: number): number | null {
  const doc = lineEl.ownerDocument;
  let node: Node | null = null;
  let nodeOffset = 0;

  const withRange = (doc as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  }).caretRangeFromPoint;
  const withPosition = (doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  }).caretPositionFromPoint;

  if (typeof withRange === 'function') {
    const range = withRange.call(doc, x, y);
    if (range) {
      node = range.startContainer;
      nodeOffset = range.startOffset;
    }
  } else if (typeof withPosition === 'function') {
    const position = withPosition.call(doc, x, y);
    if (position) {
      node = position.offsetNode;
      nodeOffset = position.offset;
    }
  }
  if (!node || !lineEl.contains(node)) return null;

  // Text nodes in document order — the same order their lengths must be
  // summed in. `acceptNode` is not needed: the walker only yields text nodes.
  const walker = doc.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
  const texts: string[] = [];
  let hitIndex = -1;
  let current = walker.nextNode();
  while (current) {
    if (current === node) hitIndex = texts.length;
    texts.push(current.textContent ?? '');
    current = walker.nextNode();
  }
  if (hitIndex === -1) return null;

  return offsetWithinLine(texts, hitIndex, nodeOffset);
}

interface ExcerptLineRowProps {
  lineNumber: number;
  text: string;
  matches: MatchRange[];
  /** UTF-16 offset into the REAL file line at which `text` begins — 0 unless
   *  the backend preview-trimmed this line. See `ExcerptLine.lineStart`. */
  lineStart: number;
  monacoId: string;
  onOpen: (lineNumber: number, column: number) => void;
}

function ExcerptLineRow({
  lineNumber,
  text,
  matches,
  lineStart,
  monacoId,
  onOpen,
}: ExcerptLineRowProps) {
  const activeThemeId = useThemeStore((s) => s.activeThemeId);
  const isMatchLine = matches.length > 0;
  // Only context lines go through colorize: a match line needs exact UTF-16
  // offsets for its <mark>, and those cannot survive tokenization into HTML.
  // useColorizedLine is still called unconditionally (with '' for match
  // lines) because a hook cannot be called conditionally; colorizing an
  // empty string is cheap and its result is discarded below.
  const colorized = useColorizedLine(isMatchLine ? '' : text, monacoId, activeThemeId);
  // Scoped to the <code> element, not the row: the row also contains the
  // gutter's line-number span, and a TreeWalker rooted on the row would yield
  // the digits as the first text node, shifting every computed offset right
  // by however many digits the line number has. `.search-excerpt-code`'s
  // text is exactly what `lineStart` and the match offsets are measured
  // against.
  const codeRef = useRef<HTMLElement>(null);

  function openAtPoint(e: React.MouseEvent<HTMLDivElement>) {
    const fallback = columnFor(lineStart, matches[0]?.start ?? 0);
    if (!codeRef.current) {
      onOpen(lineNumber, fallback);
      return;
    }
    const offset = offsetFromPoint(codeRef.current, e.clientX, e.clientY);
    onOpen(lineNumber, offset === null ? fallback : columnFor(lineStart, offset));
  }

  return (
    <div
      className={`search-excerpt-line${isMatchLine ? ' is-match' : ''}`}
      onClick={(e) => {
        // Mod+click opens; a plain click still only selects the excerpt, so a
        // long result list stays scannable without bouncing to files.
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          openAtPoint(e);
        }
      }}
      onDoubleClick={(e) => openAtPoint(e)}
    >
      <span className="search-excerpt-gutter">{lineNumber}</span>
      <code ref={codeRef} className="search-excerpt-code">
        {isMatchLine || colorized === null ? (
          splitByMatches(text, matches).map((segment, i) =>
            segment.isMatch ? (
              <mark key={i} className="search-match-highlight">
                {segment.text}
              </mark>
            ) : (
              <span key={i}>{segment.text}</span>
            ),
          )
        ) : (
          <span dangerouslySetInnerHTML={{ __html: colorized }} />
        )}
      </code>
    </div>
  );
}

function FileExcerptBlock({
  filePath,
  relativePath,
  excerpts,
  matchCount,
  collapsed,
  activeExcerptId,
  onToggleCollapse,
  onOpenExcerpt,
  onFocusExcerpt,
  onExpand,
  hotExcerptIds,
  registry,
  onFirstEdit,
}: FileExcerptBlockProps) {
  const fileName = filePath.split('/').pop() || filePath;
  const monacoId = detectLanguage(fileName).monacoId;
  // Excerpts whose hydration reported `onUnavailable()` — no Monaco, the
  // hidden-areas API is gone, or the range wasn't sane against the model.
  // These render cold even while their file is otherwise hot.
  const [coldFallback, setColdFallback] = useState<string[]>([]);

  // `HydratedExcerpt`'s mount effect (Task 8) depends on `onUnavailable` by
  // reference, so a fresh closure per render would remount every live editor
  // on unrelated churn elsewhere in the results list — the same class of bug
  // that effect's excerpt-primitive dependency list was already fixed for
  // (Task 8 review). A plain `useCallback` can't produce that per-excerpt
  // closure because this is built inside `excerpts.map()` below, and the
  // number of excerpts varies across renders — calling a hook a variable
  // number of times per render breaks the Rules of Hooks. Instead, cache one
  // stable no-arg closure per excerpt id in a ref: the cache outlives
  // individual renders, so the SAME excerpt id always gets back the SAME
  // function object. Stale entries for excerpt ids that stop appearing (a new
  // search reusing this file's path) just sit unused until this block
  // unmounts; excerpt ids are cheap and the map is scoped to one file block.
  const unavailableCallbacks = useRef(new Map<string, () => void>());
  function onUnavailableFor(excerptId: string): () => void {
    const cache = unavailableCallbacks.current;
    const cached = cache.get(excerptId);
    if (cached) return cached;
    const fn = () =>
      setColdFallback((prev) => (prev.includes(excerptId) ? prev : [...prev, excerptId]));
    cache.set(excerptId, fn);
    return fn;
  }

  return (
    <div className="search-excerpt-file">
      <button
        className="search-excerpt-file-header"
        onClick={() => onToggleCollapse(filePath)}
        title={filePath}
      >
        <span className="search-file-chevron">
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </span>
        <span className="search-file-icon">{getFileIcon(fileName, 14)}</span>
        <span className="search-file-name">{fileName}</span>
        <span className="search-file-path">{relativePath !== fileName ? relativePath : ''}</span>
        <span className="search-file-count">{matchCount}</span>
      </button>

      {!collapsed &&
        excerpts.map((excerpt) => (
          <div
            key={excerpt.id}
            // Lets ExcerptList's reveal handler find and scroll to this exact
            // excerpt within its (virtualized, per-FILE) block once the
            // block has mounted — the virtualizer itself only knows how to
            // scroll to a block index, not a sub-element inside one.
            data-excerpt-id={excerpt.id}
            className={`search-excerpt${activeExcerptId === excerpt.id ? ' active' : ''}`}
            onMouseDown={() => onFocusExcerpt(excerpt.id)}
          >
            <button
              type="button"
              className="search-excerpt-divider search-excerpt-divider-top"
              title="Expand context above"
              aria-label="Expand context above"
              onClick={() => onExpand(excerpt.id, 'up')}
            >
              <ChevronUp size={10} aria-hidden="true" />
            </button>

            {hotExcerptIds.includes(excerpt.id) && !coldFallback.includes(excerpt.id) ? (
              <HydratedExcerpt
                filePath={filePath}
                excerpt={excerpt}
                registry={registry}
                lineHeight={LINE_HEIGHT}
                onFirstEdit={onFirstEdit}
                onUnavailable={onUnavailableFor(excerpt.id)}
              />
            ) : (
              excerpt.lines.map((line) => (
                <ExcerptLineRow
                  key={line.lineNumber}
                  lineNumber={line.lineNumber}
                  text={line.text}
                  matches={line.matches}
                  lineStart={line.lineStart}
                  monacoId={monacoId}
                  onOpen={(lineNumber, column) => onOpenExcerpt(filePath, lineNumber, column)}
                />
              ))
            )}

            <button
              type="button"
              className="search-excerpt-divider search-excerpt-divider-bottom"
              title="Expand context below (Shift+Enter)"
              aria-label="Expand context below"
              onClick={() => onExpand(excerpt.id, 'down')}
            >
              <ChevronDown size={10} aria-hidden="true" />
            </button>
          </div>
        ))}
    </div>
  );
}

export default FileExcerptBlock;
