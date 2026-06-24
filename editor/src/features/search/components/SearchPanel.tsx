import { useState, useCallback, useEffect } from 'react';
import { Search, ChevronDown, ChevronRight, MoreHorizontal } from 'lucide-react';
import { useSearchStore } from '../../../stores/search';
import { useWorkspaceStore } from '../../../stores/workspace';
import { getFileIcon } from '../../../utils/file-icons';
import { useDebouncedValue } from '../../../hooks/useDebouncedValue';

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
  const isSearching = useSearchStore((s) => s.isSearching);
  const search = useSearchStore((s) => s.search);
  const clearResults = useSearchStore((s) => s.clearResults);

  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  const [showFilters, setShowFilters] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());

  const debouncedQuery = useDebouncedValue(query, 300);

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
              placeholder="files to include"
              value={includePattern}
              onChange={(e) => setIncludePattern(e.target.value)}
              spellCheck={false}
            />
            <input
              className="search-filter-input"
              type="text"
              placeholder="files to exclude"
              value={excludePattern}
              onChange={(e) => setExcludePattern(e.target.value)}
              spellCheck={false}
            />
          </div>
        )}
      </div>

      <div className="search-results">
        {isSearching && (
          <div className="search-summary">Searching...</div>
        )}
        {!isSearching && query && results.length > 0 && (
          <div className="search-summary">
            {totalMatches} result{totalMatches !== 1 ? 's' : ''} in {fileCount} file{fileCount !== 1 ? 's' : ''}
          </div>
        )}
        {!isSearching && query && results.length === 0 && query.length >= 3 && (
          <div className="search-summary">No results found.</div>
        )}

        {results.map((fileResult) => {
          const isCollapsed = collapsedFiles.has(fileResult.path);
          const fileName = fileResult.path.split('/').pop() || fileResult.path;
          const relPath = workspacePath
            ? fileResult.path.replace(workspacePath + '/', '')
            : fileResult.path;

          return (
            <div key={fileResult.path} className="search-file-group">
              <button
                className="search-file-header"
                onClick={() => toggleFileCollapse(fileResult.path)}
                title={fileResult.path}
              >
                <span className="search-file-chevron">
                  {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </span>
                <span className="search-file-icon">{getFileIcon(fileName, 14)}</span>
                <span className="search-file-name">{fileName}</span>
                <span className="search-file-path">{relPath !== fileName ? relPath : ''}</span>
                <span className="search-file-count">{fileResult.matches.length}</span>
              </button>

              {!isCollapsed && (
                <div className="search-match-list">
                  {fileResult.matches.map((match, idx) => {
                    const before = match.lineContent.slice(0, match.matchStart);
                    const matched = match.lineContent.slice(match.matchStart, match.matchEnd);
                    const after = match.lineContent.slice(match.matchEnd);

                    return (
                      <button
                        key={idx}
                        className="search-match-row"
                        onClick={() => handleMatchClick(fileResult.path, match.lineNumber, match.matchStart)}
                        title={`Line ${match.lineNumber}: ${match.lineContent.trim()}`}
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
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default SearchPanel;
