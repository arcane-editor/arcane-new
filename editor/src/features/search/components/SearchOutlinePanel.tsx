import { useMemo } from 'react';
import { flushSync } from 'react-dom';
import { useSearchStore } from '../../../stores/search';
import { useWorkspaceStore } from '../../../stores/workspace';
import { getFileIcon } from '../../../utils/file-icons';
import { buildExcerpts } from '../services/excerpt-model';

function plural(count: number): string {
  return count === 1 ? '' : 's';
}

function SearchOutlinePanel() {
  const sessionId = useSearchStore((s) => s.activeSessionId);
  const session = useSearchStore((s) => s.sessions[s.activeSessionId]);
  const update = useSearchStore((s) => s.update);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  const files = useMemo(
    () =>
      (session?.results ?? []).map((file) => ({
        path: file.path,
        name: file.path.split('/').pop() || file.path,
        relativePath: workspacePath ? file.path.replace(workspacePath + '/', '') : file.path,
        excerpts: buildExcerpts(file),
        matchCount: file.matches.length,
      })),
    [session?.results, workspacePath],
  );

  if (!session) return null;

  const summary = session.isSearching
    ? 'Searching…'
    : session.results.length > 0
      ? `${session.totalMatches} result${plural(session.totalMatches)} in ${session.fileCount} file${plural(session.fileCount)}`
      : '';

  function reveal(excerptId: string) {
    // `activeExcerptId` in the store first, unconditionally: ExcerptList's own
    // mount effect reads this back directly, so the reveal still lands even
    // if the flushSync guarantee below were ever not enough.
    update(sessionId, { activeExcerptId: excerptId });

    // `sessionId` (the search store's activeSessionId) IS the tab's path
    // (`search://N`) — but this session's tab may not be the ACTIVE editor
    // tab right now (e.g. the user is looking at a .cs file while this
    // outline stays visible in the sidebar). `EditorPanel` only mounts
    // `ExcerptList` for the active tab, so clicking a row while a different
    // tab is focused would otherwise activate the search tab on a LATER
    // render than this handler, and a plain `dispatchEvent` right after
    // `setActiveFile` would fire before `ExcerptList`'s effect has even
    // registered its 'search-reveal-excerpt' listener — the event is lost
    // and nothing scrolls. `flushSync` forces the activation's render/commit
    // (and, since the triggering update lands in the sync lane, its
    // useEffects) to finish before this function continues, so by the time
    // the event below dispatches, a freshly-mounted ExcerptList has already
    // subscribed.
    flushSync(() => {
      useWorkspaceStore.getState().setActiveFile(sessionId);
    });

    window.dispatchEvent(
      new CustomEvent('search-reveal-excerpt', { detail: { sessionId, excerptId } }),
    );
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header">SEARCH RESULTS</div>
      <div className="search-summary">{summary}</div>
      <div className="search-outline">
        {files.map((file) => (
          <div key={file.path} className="search-outline-file">
            <div className="search-outline-file-header" title={file.relativePath}>
              <span className="search-file-icon">{getFileIcon(file.name, 14)}</span>
              <span className="search-file-name">{file.name}</span>
              <span className="search-file-count">{file.matchCount}</span>
            </div>
            {file.excerpts.map((excerpt) => (
              <button
                key={excerpt.id}
                className={`search-outline-row${session.activeExcerptId === excerpt.id ? ' active' : ''}`}
                onClick={() => reveal(excerpt.id)}
              >
                <span className="search-match-line">{excerpt.startLine}</span>
                <span className="search-match-content">
                  {excerpt.lines.find((l) => l.matches.length > 0)?.text.trim() ?? ''}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export default SearchOutlinePanel;
