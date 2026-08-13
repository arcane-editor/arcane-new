import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, EyeOff, SlidersHorizontal, Boxes } from 'lucide-react';
import { useSearchStore } from '../../../stores/search';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useSettingsStore } from '../../../stores/settings';
import { useDebouncedValue } from '../../../hooks/useDebouncedValue';
import { autoSearchAction, summaryFor, searchSignature } from '../services/search-model';
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
  // Settings, not session fields, but `search()` reads both fresh on every
  // call and folds them into `searchedSignature` — so the auto-search
  // effect must react to them too, or a settings change made while this
  // tab was unmounted would look "already searched" on the next remount
  // and silently fail to take effect until the user pressed Enter (M3,
  // final re-review).
  const useSmartcase = useSettingsStore((s) => s.settings['search.useSmartcase']);
  const contextLines = useSettingsStore((s) => s.settings['search.contextLines']);

  const inputRef = useRef<HTMLInputElement>(null);
  const [showFilters, setShowFilters] = useState(false);
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
  //
  // This effect also fires on every MOUNT, including a remount: this tab's
  // content (`SearchResultsTab`) only renders while it is the active tab, so
  // switching away and back unmounts and remounts it, and `useDebouncedValue`
  // seeds its state with the current value with no delay on first render —
  // so a mount with an unchanged query looks identical to a real edit. The
  // `searchedSignature` comparison below is what tells them apart: it's
  // stamped on the session the moment a search actually runs, so an
  // unchanged remount matches it and is skipped, while a genuine change to
  // the query, any session-owned option, OR the useSmartcase/contextLines
  // SETTINGS (read fresh by search() on every call, so they belong in the
  // signature too) produces a different signature and still runs.
  useEffect(() => {
    const action = autoSearchAction(debouncedQuery);
    if (action === 'search') {
      const signature = searchSignature({
        query: debouncedQuery,
        isRegex: session?.isRegex ?? false,
        caseSensitive: session?.caseSensitive ?? false,
        wholeWord: session?.wholeWord ?? false,
        includeIgnored: session?.includeIgnored ?? false,
        includePattern: session?.includePattern ?? '',
        excludePattern: session?.excludePattern ?? '',
        useSmartcase,
        contextLines,
        includeUnityAssets: session?.includeUnityAssets ?? false,
      });
      if (session?.searchedSignature === signature) return;
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
    useSmartcase,
    contextLines,
    session?.includeUnityAssets,
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

  const toggle = (
    key: 'isRegex' | 'caseSensitive' | 'wholeWord' | 'includeIgnored' | 'includeUnityAssets',
  ) => update(sessionId, { [key]: !session[key] } as Partial<typeof session>);

  const summary = summaryFor(session);

  // Filters stay folded until they hold something. They are empty in almost
  // every search, and two full-width fields sitting open dominated a surface
  // whose subject is the results below them.
  const hasFilters = Boolean(session.includePattern || session.excludePattern);
  const filtersOpen = showFilters || hasFilters;

  return (
    <div className="search-tab-bar">
      <div className="search-console">
        <div className={`search-input-wrapper${session.isSearching ? ' is-searching' : ''}`}>
          <Search size={14} className="search-input-icon" aria-hidden="true" />
          <input
            ref={inputRef}
            className="search-input"
            type="text"
            placeholder="Search all files"
            aria-label="Search all files"
            value={session.query}
            onChange={(e) => update(sessionId, { query: e.target.value, historyIndex: -1 })}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
          />
          <div className="search-toggle-group">
            <button
              type="button"
              className={`search-toggle-btn${session.caseSensitive ? ' active' : ''}`}
              title="Match case (⌥⌘C)"
              aria-pressed={session.caseSensitive}
              onClick={() => toggle('caseSensitive')}
            >
              Aa
            </button>
            <button
              type="button"
              className={`search-toggle-btn${session.wholeWord ? ' active' : ''}`}
              title="Match whole word (⌥⌘W)"
              aria-pressed={session.wholeWord}
              onClick={() => toggle('wholeWord')}
            >
              ab
            </button>
            <button
              type="button"
              className={`search-toggle-btn${session.isRegex ? ' active' : ''}`}
              title="Use regular expression (⌥⌘X)"
              aria-pressed={session.isRegex}
              onClick={() => toggle('isRegex')}
            >
              .*
            </button>
            <span className="search-toggle-divider" aria-hidden="true" />
            <button
              type="button"
              className={`search-toggle-btn${session.includeIgnored ? ' active' : ''}`}
              title="Search ignored files"
              aria-pressed={session.includeIgnored}
              onClick={() => toggle('includeIgnored')}
            >
              <EyeOff size={13} />
            </button>
            <button
              type="button"
              className={`search-toggle-btn${session.includeUnityAssets ? ' active' : ''}`}
              title="Search scenes, prefabs and .meta files"
              aria-pressed={session.includeUnityAssets}
              aria-label="Search Unity assets"
              onClick={() => toggle('includeUnityAssets')}
            >
              <Boxes size={13} />
            </button>
            <button
              type="button"
              className={`search-toggle-btn${filtersOpen ? ' active' : ''}`}
              title="Filter by path"
              aria-pressed={filtersOpen}
              aria-label="Filter by path"
              onClick={() => setShowFilters((v) => !v)}
            >
              <SlidersHorizontal size={13} />
            </button>
          </div>
        </div>

        <span className="search-tab-count" role="status">
          {summary}
        </span>
      </div>

      {filtersOpen && (
        <div className="search-console search-filter-row">
          <label className="search-filter-field">
            <span className="search-filter-label">include</span>
            <input
              className="search-filter-input"
              type="text"
              placeholder="Assets/**, *.cs"
              value={session.includePattern}
              onChange={(e) => update(sessionId, { includePattern: e.target.value })}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <label className="search-filter-field">
            <span className="search-filter-label">exclude</span>
            <input
              className="search-filter-input"
              type="text"
              placeholder="**/Editor/**"
              value={session.excludePattern}
              onChange={(e) => update(sessionId, { excludePattern: e.target.value })}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
        </div>
      )}
    </div>
  );
}

export default SearchQueryBar;
