import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { getFileIcon } from '../../../utils/file-icons';
import { detectLanguage } from '../../../utils/language-detect';
import { getMonacoInstance } from '../../../utils/monaco-instance';
import { splitByMatches, stripTrailingBreak } from '../services/highlight';
import type { Excerpt, MatchRange } from '../services/excerpt-model';

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
}

/** Colorized HTML per (languageId, text). Search results repeat lines across
 *  excerpts constantly, and colorize is an async tokenizer pass, so without a
 *  cache scrolling re-tokenizes the same lines on every virtualization pass.
 *  Values are stored already stripped of Monaco's trailing `<br/>` (see
 *  `stripTrailingBreak`), so every reader gets clean HTML for free. */
const colorCache = new Map<string, string>();

interface ColorizedResult {
  /** The (monacoId, text) key this HTML was actually computed for. */
  key: string;
  html: string;
}

function useColorizedLine(text: string, monacoId: string): string | null {
  const key = `${monacoId} ${text}`;
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
  }, [text, monacoId, key]);

  // `result` may still hold the PREVIOUS (text, monacoId) pair's HTML: the
  // `cancelled` flag above only prevents a stale async write from landing —
  // it does nothing about a stale READ of state nobody has updated yet. A
  // row whose `text` prop changes while Monaco is unavailable (the effect
  // above returns immediately, before ever calling `setResult`) would
  // otherwise go on rendering the OLD text's colorized HTML forever. Only
  // hand back HTML that was actually computed for the CURRENT key.
  return result?.key === key ? result.html : null;
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
  const isMatchLine = matches.length > 0;
  // Only context lines go through colorize: a match line needs exact UTF-16
  // offsets for its <mark>, and those cannot survive tokenization into HTML.
  // useColorizedLine is still called unconditionally (with '' for match
  // lines) because a hook cannot be called conditionally; colorizing an
  // empty string is cheap and its result is discarded below.
  const colorized = useColorizedLine(isMatchLine ? '' : text, monacoId);

  return (
    <div
      className={`search-excerpt-line${isMatchLine ? ' is-match' : ''}`}
      // The real editor column is `lineStart + matchStart`, not `matchStart`
      // alone (src/types/index.ts, SearchMatch.lineStart): a long line gets
      // preview-trimmed around its match, so `matches[0].start` is an offset
      // into the TRIMMED text this row renders, not into the real file line.
      onDoubleClick={() => onOpen(lineNumber, lineStart + (matches[0]?.start ?? 0) + 1)}
    >
      <span className="search-excerpt-gutter">{lineNumber}</span>
      <code className="search-excerpt-code">
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
}: FileExcerptBlockProps) {
  const fileName = filePath.split('/').pop() || filePath;
  const monacoId = detectLanguage(fileName).monacoId;

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
            className={`search-excerpt${activeExcerptId === excerpt.id ? ' active' : ''}`}
            onMouseDown={() => onFocusExcerpt(excerpt.id)}
          >
            <button
              className="search-excerpt-expand"
              title="Expand context above (Shift+Enter)"
              onClick={() => onExpand(excerpt.id, 'up')}
            >
              ⌃
            </button>

            {excerpt.lines.map((line) => (
              <ExcerptLineRow
                key={line.lineNumber}
                lineNumber={line.lineNumber}
                text={line.text}
                matches={line.matches}
                lineStart={line.lineStart}
                monacoId={monacoId}
                onOpen={(lineNumber, column) => onOpenExcerpt(filePath, lineNumber, column)}
              />
            ))}

            <button
              className="search-excerpt-expand"
              title="Expand context below"
              onClick={() => onExpand(excerpt.id, 'down')}
            >
              ⌄
            </button>
          </div>
        ))}
    </div>
  );
}

export default FileExcerptBlock;
