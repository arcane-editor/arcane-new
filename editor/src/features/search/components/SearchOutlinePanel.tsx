import { useMemo } from 'react';
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
    update(sessionId, { activeExcerptId: excerptId });
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
