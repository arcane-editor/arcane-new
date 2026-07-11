import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Search, ChevronDown, ChevronRight, MoreHorizontal } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useSearchStore } from '../../../stores/search';
import { useWorkspaceStore } from '../../../stores/workspace';
import { getFileIcon } from '../../../utils/file-icons';
import { useDebouncedValue } from '../../../hooks/useDebouncedValue';
import { flattenRows } from '../services/search-model';

// Fixed row heights the virtualizer estimates from; `measureElement` (below)
// self-corrects if the real rendered height ever drifts from these.
const FILE_ROW_HEIGHT = 24;
const MATCH_ROW_HEIGHT = 22;
// The indeterminate loading bar only appears once a search has been running
// continuously for this long, so a near-instant search never flashes it.
const LOADING_BAR_DELAY_MS = 100;

/**
 * Gates a boolean behind a minimum continuous-`true` duration: `value` must
 * stay `true` for `delayMs` before this flips `true`, and it snaps back to
 * `false` the instant `value` does. Used to keep brief/instant searches from
 * flashing the indeterminate loading bar.
 */
function useDelayedTrue(value: boolean, delayMs: number): boolean {
  const [delayed, setDelayed] = useState(false);
  useEffect(() => {
    if (!value) {
      setDelayed(false);
      return;
    }
    const timer = setTimeout(() => setDelayed(true), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return delayed;
}

function plural(count: number): string {
  return count === 1 ? '' : 's';
}

function SearchPanel() {
  const query = useSearchStore((s) => s.query);
  const setQuery = useSearchStore((s) => s.setQuery);
  const isRegex = useSearchStore((s) => s.isRegex);
  const toggleRegex = useSearchStore((s) => s.toggleRegex);
  const caseSensitive = useSearchStore((s) => s.caseSensitive);
  const toggleCaseSensitive = useSearchStore((s) => s.toggleCaseSensitive);
  const wholeWord = useSearchStore((s) => s.wholeWord);
  const toggleWholeWord = useSearchStore((s) => s.toggleWholeWord);
  const includePattern = useSearchStore((s) => s.includePattern);
  const setIncludePattern = useSearchStore((s) => s.setIncludePattern);
  const excludePattern = useSearchStore((s) => s.excludePattern);
  const setExcludePattern = useSearchStore((s) => s.setExcludePattern);
  const results = useSearchStore((s) => s.results);
  const totalMatches = useSearchStore((s) => s.totalMatches);
  const fileCount = useSearchStore((s) => s.fileCount);
  const truncated = useSearchStore((s) => s.truncated);
  const isSearching = useSearchStore((s) => s.isSearching);
  const activeSearchId = useSearchStore((s) => s.activeSearchId);
  const searchError = useSearchStore((s) => s.searchError);
  const search = useSearchStore((s) => s.search);
  const clearResults = useSearchStore((s) => s.clearResults);

  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  const [showFilters, setShowFilters] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());

  const debouncedQuery = useDebouncedValue(query, 300);
  const showLoadingBar = useDelayedTrue(isSearching, LOADING_BAR_DELAY_MS);

  const resultsRef = useRef<HTMLDivElement>(null);

  // Flattened once per results/collapse change — the virtualizer needs a
  // flat, index-addressable row list rather than nested file->match arrays.
  const rows = useMemo(() => flattenRows(results, collapsedFiles), [results, collapsedFiles]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => resultsRef.current,
    estimateSize: (index) => (rows[index]?.kind === 'file' ? FILE_ROW_HEIGHT : MATCH_ROW_HEIGHT),
    overscan: 10,
  });

  const triggerSearch = useCallback(() => {
    if (workspacePath && query) {
      search(workspacePath);
    } else if (!query) {
      clearResults();
    }
  }, [workspacePath, query, search, clearResults]);

  // Auto-search when the debounced query settles (>= 3 chars); clear on empty.
  useEffect(() => {
    if (debouncedQuery.length >= 3) {
      triggerSearch();
    } else if (debouncedQuery.length === 0) {
      clearResults();
    }
  }, [debouncedQuery, isRegex, caseSensitive, wholeWord, includePattern, excludePattern, triggerSearch, clearResults]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      triggerSearch();
    }
  }

  function toggleFileCollapse(path: string) {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  async function handleMatchClick(absolutePath: string, lineNumber: number, matchStart: number) {
    const fileName = absolutePath.split('/').pop() || '';
    await useWorkspaceStore.getState().openFile(absolutePath, fileName);
    window.dispatchEvent(
      new CustomEvent('navigate-to-line', {
        detail: { line: lineNumber, column: matchStart + 1 },
      }),
    );
  }

  const showNoResults =
    !isSearching &&
    query.length >= 3 &&
    results.length === 0 &&
    activeSearchId !== null &&
    activeSearchId > 0;

  // While streaming, the store's own totalMatches/fileCount only land on
  // search-complete (see search-model.ts applyBatch/applyComplete) — derive
  // a live count from the accumulated `results` so the summary row updates
  // as each batch arrives instead of sitting frozen on stale/zero totals.
  const streamingMatches = useMemo(
    () => results.reduce((sum, f) => sum + f.matches.length, 0),
    [results],
  );

  let summaryText = '';
  if (isSearching) {
    summaryText =
      streamingMatches > 0
        ? `${streamingMatches} result${plural(streamingMatches)} in ${results.length} file${plural(results.length)} (searching…)`
        : 'Searching…';
  } else if (showNoResults) {
    summaryText = 'No results found.';
  } else if (results.length > 0) {
    summaryText = `${totalMatches} result${plural(totalMatches)} in ${fileCount} file${plural(fileCount)}`;
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header">SEARCH</div>

      <div className="search-input-area">
        <div className="search-input-row">
          <div className="search-input-wrapper">
            <Search size={14} className="search-input-icon" />
            <input
              className="search-input"
              type="text"
              placeholder="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              spellCheck={false}
            />
          </div>
          <div className="search-toggle-group">
            <button
              className={`search-toggle-btn${caseSensitive ? ' active' : ''}`}
              title="Match Case"
              onClick={toggleCaseSensitive}
            >
              Aa
            </button>
            <button
              className={`search-toggle-btn${wholeWord ? ' active' : ''}`}
              title="Match Whole Word"
              onClick={toggleWholeWord}
            >
              Ab|
            </button>
            <button
              className={`search-toggle-btn${isRegex ? ' active' : ''}`}
              title="Use Regular Expression"
              onClick={toggleRegex}
            >
              .*
            </button>
            <button
              className={`search-toggle-btn${showFilters ? ' active' : ''}`}
              title="Toggle Filter Options"
              onClick={() => setShowFilters((v) => !v)}
            >
              <MoreHorizontal size={14} />
            </button>
          </div>
        </div>

        {showFilters && (
          <div className="search-filter-inputs">
            <input
              className="search-filter-input"
              type="text"
              placeholder="files to include (e.g. src/**, *.ts)"
              value={includePattern}
              onChange={(e) => setIncludePattern(e.target.value)}
              spellCheck={false}
            />
            <input
              className="search-filter-input"
              type="text"
              placeholder="files to exclude (e.g. **/node_modules/**, *.min.js)"
              value={excludePattern}
              onChange={(e) => setExcludePattern(e.target.value)}
              spellCheck={false}
            />
          </div>
        )}
      </div>

      <div className="search-results" ref={resultsRef}>
        {/* Zero-height sticky anchor: keeps the loading bar pinned to the
            visible top of the scroll area (not the top of the scrolled
            content) without taking any space in the flow itself. */}
        <div className="search-progress-anchor">
          {showLoadingBar && <div className="search-progress-bar" />}
        </div>

        {/* Always rendered (fixed height) so switching between searching /
            results / no-results / error never displaces the list below it. */}
        {searchError ? (
          <div className="search-summary search-summary-error">{searchError}</div>
        ) : (
          <div className="search-summary">{summaryText}</div>
        )}

        {truncated && (
          <div className="search-truncation-notice">
            Results capped — showing first {totalMatches} match{plural(totalMatches)}.
          </div>
        )}

        <div
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualItem) => {
            const row = rows[virtualItem.index];
            if (!row) return null;

            if (row.kind === 'file') {
              const fileResult = row.file;
              const isCollapsed = row.collapsed;
              const fileName = fileResult.path.split('/').pop() || fileResult.path;
              const relPath = workspacePath
                ? fileResult.path.replace(workspacePath + '/', '')
                : fileResult.path;

              return (
                <button
                  key={`file:${fileResult.path}`}
                  data-index={virtualItem.index}
                  ref={rowVirtualizer.measureElement}
                  className="search-file-header"
                  onClick={() => toggleFileCollapse(fileResult.path)}
                  title={fileResult.path}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <span className="search-file-chevron">
                    {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  </span>
                  <span className="search-file-icon">{getFileIcon(fileName, 14)}</span>
                  <span className="search-file-name">{fileName}</span>
                  <span className="search-file-path">{relPath !== fileName ? relPath : ''}</span>
                  {fileResult.truncated && (
                    <span className="search-file-truncated">(truncated)</span>
                  )}
                  <span className="search-file-count">{fileResult.matches.length}</span>
                </button>
              );
            }

            const { match, filePath } = row;
            const before = match.lineContent.slice(0, match.matchStart);
            const matched = match.lineContent.slice(match.matchStart, match.matchEnd);
            const after = match.lineContent.slice(match.matchEnd);

            return (
              <button
                key={`match:${filePath}:${match.lineNumber}:${match.matchStart}:${match.matchEnd}`}
                data-index={virtualItem.index}
                ref={rowVirtualizer.measureElement}
                className="search-match-row"
                onClick={() => handleMatchClick(filePath, match.lineNumber, match.matchStart + (match.lineStart ?? 0))}
                title={`Line ${match.lineNumber}: ${match.lineContent.trim()}`}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                <span className="search-match-line">{match.lineNumber}</span>
                <span className="search-match-content">
                  {before}
                  <mark className="search-match-highlight">{matched}</mark>
                  {after}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default SearchPanel;
