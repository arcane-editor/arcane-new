import { useCallback, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { flushSync } from 'react-dom';
import { useSearchStore } from '../../../stores/search';
import { useWorkspaceStore } from '../../../stores/workspace';
import { getFileIcon } from '../../../utils/file-icons';
import { buildExcerpts } from '../services/excerpt-model';
import { summaryFor } from '../services/search-model';

/** Matches `.search-outline-file-header`'s box height (padding 4px top/bottom
 *  + a 12px line at line-height 1.4 rounds to ~21px; 24 leaves slack).
 *  `measureElement` corrects the real height once a block is measured, so
 *  this only has to be a reasonable starting guess, not exact. */
const HEADER_HEIGHT = 24;
/** Matches `.search-outline-row`'s box height (padding 2px top/bottom). */
const ROW_HEIGHT = 20;

function SearchOutlinePanel() {
  const sessionId = useSearchStore((s) => s.activeSessionId);
  const session = useSearchStore((s) => s.sessions[s.activeSessionId]);
  const update = useSearchStore((s) => s.update);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const scrollRef = useRef<HTMLDivElement>(null);

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

  // Estimated from the block's own shape, exactly like ExcerptList's
  // `estimateSize` — a file with many excerpts is far taller than one with a
  // single match, and `measureElement` (below) corrects the rest once a
  // block is actually rendered.
  const estimateSize = useCallback(
    (index: number) => {
      const file = files[index];
      if (!file) return HEADER_HEIGHT;
      return HEADER_HEIGHT + file.excerpts.length * ROW_HEIGHT;
    },
    [files],
  );

  // Keyed on the file's own path, not the default (index) — same reasoning
  // as ExcerptList's `getItemKey`: a new query REPLACES `results` wholesale,
  // so index 0 can go from one file to a completely different one between
  // searches, and an index-keyed measurement cache would serve the previous
  // query's height for a row that hasn't scrolled into view yet.
  const getItemKey = useCallback((index: number) => files[index]?.path ?? index, [files]);

  const virtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    overscan: 6,
  });

  if (!session) return null;

  const summary = summaryFor(session);

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
      <div className={`search-summary${session.searchError ? ' search-summary-error' : ''}`}>
        {summary}
      </div>
      <div className="search-outline" ref={scrollRef}>
        <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const file = files[item.index];
            if (!file) return null;
            return (
              <div
                key={file.path}
                data-index={item.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${item.start}px)`,
                }}
              >
                <div className="search-outline-file">
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
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default SearchOutlinePanel;
