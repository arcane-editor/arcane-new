import { useCallback, useEffect, useRef } from 'react';
import { Search, EyeOff } from 'lucide-react';
import { useSearchStore } from '../../../stores/search';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useDebouncedValue } from '../../../hooks/useDebouncedValue';
import { autoSearchAction, summaryFor } from '../services/search-model';
import { pushQuery, historyStep } from '../services/query-history';

interface SearchQueryBarProps {
  sessionId: string;
}

function SearchQueryBar({ sessionId }: SearchQueryBarProps) {
  const session = useSearchStore((s) => s.sessions[sessionId]);
  const update = useSearchStore((s) => s.update);
  const search = useSearchStore((s) => s.search);
  const clearResults = useSearchStore((s) => s.clearResults);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  const inputRef = useRef<HTMLInputElement>(null);
  const debouncedQuery = useDebouncedValue(session?.query ?? '', 300);

  // Focus on mount: opening a search tab should leave you typing, not
  // hunting for the field.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [sessionId]);

  // `search.openTab` dispatches this when the tab already exists — bringing
  // an existing tab forward doesn't remount this component (no `sessionId`
  // change), so the mount-focus effect above wouldn't fire again.
  useEffect(() => {
    function onFocus() {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    window.addEventListener('search-focus-query', onFocus);
    return () => window.removeEventListener('search-focus-query', onFocus);
  }, []);

  // Auto-search off the DEBOUNCED value only. Depending on anything that
  // changes identity per keystroke re-runs this per character and fires a
  // full workspace scan for each one — see the comment on autoSearchAction.
  useEffect(() => {
    const action = autoSearchAction(debouncedQuery);
    if (action === 'search') {
      if (workspacePath) search(sessionId, workspacePath);
    } else if (action === 'clear') {
      clearResults(sessionId);
    }
  }, [
    debouncedQuery,
    sessionId,
    workspacePath,
    search,
    clearResults,
    session?.isRegex,
    session?.caseSensitive,
    session?.wholeWord,
    session?.includeIgnored,
    session?.includePattern,
    session?.excludePattern,
  ]);

  const runNow = useCallback(() => {
    if (!session) return;
    update(sessionId, { history: pushQuery(session.history, session.query), historyIndex: -1 });
    if (workspacePath && session.query) search(sessionId, workspacePath);
  }, [session, sessionId, update, search, workspacePath]);

  if (!session) return null;

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      runNow();
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const step = historyStep(
        session!.history,
        session!.historyIndex,
        e.key === 'ArrowUp' ? 'back' : 'forward',
      );
      if (!step) return;
      e.preventDefault();
      update(sessionId, { query: step.query, historyIndex: step.index });
    }
  }

  const toggle = (key: 'isRegex' | 'caseSensitive' | 'wholeWord' | 'includeIgnored') =>
    update(sessionId, { [key]: !session[key] } as Partial<typeof session>);

  const summary = summaryFor(session);

  return (
    <div className="search-tab-bar">
      <div className="search-input-row">
        <div className="search-input-wrapper">
          <Search size={14} className="search-input-icon" />
          <input
            ref={inputRef}
            className="search-input"
            type="text"
            placeholder="Search"
            value={session.query}
            onChange={(e) => update(sessionId, { query: e.target.value, historyIndex: -1 })}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
          />
        </div>
        <div className="search-toggle-group">
          <button
            className={`search-toggle-btn${session.caseSensitive ? ' active' : ''}`}
            title="Match Case (Alt+Cmd+C)"
            onClick={() => toggle('caseSensitive')}
          >
            Aa
          </button>
          <button
            className={`search-toggle-btn${session.wholeWord ? ' active' : ''}`}
            title="Match Whole Word (Alt+Cmd+W)"
            onClick={() => toggle('wholeWord')}
          >
            Ab|
          </button>
          <button
            className={`search-toggle-btn${session.isRegex ? ' active' : ''}`}
            title="Use Regular Expression (Alt+Cmd+X)"
            onClick={() => toggle('isRegex')}
          >
            .*
          </button>
          <button
            className={`search-toggle-btn${session.includeIgnored ? ' active' : ''}`}
            title="Include Ignored Files"
            onClick={() => toggle('includeIgnored')}
          >
            <EyeOff size={14} />
          </button>
        </div>
        <span className="search-tab-count">{summary}</span>
      </div>

      <div className="search-filter-inputs">
        <input
          className="search-filter-input"
          type="text"
          placeholder="files to include (e.g. Assets/**, *.cs)"
          value={session.includePattern}
          onChange={(e) => update(sessionId, { includePattern: e.target.value })}
          spellCheck={false}
          autoComplete="off"
        />
        <input
          className="search-filter-input"
          type="text"
          placeholder="files to exclude (e.g. **/Editor/**)"
          value={session.excludePattern}
          onChange={(e) => update(sessionId, { excludePattern: e.target.value })}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
    </div>
  );
}

export default SearchQueryBar;
