import { useMemo, useDeferredValue } from 'react';
import { ChevronDown, ChevronRight, File, LoaderCircle } from 'lucide-react';
import { useReferencesStore, type ReferenceLine } from '../../../stores/references';
import { useWorkspaceStore } from '../../../stores/workspace';
import { setPendingNavigation } from '../../../utils/editor-navigation';
import { recordJumpOrigin } from '../../../utils/jump-history';

/** Render the matched span inside a preview line without a second pass over it. */
function Preview({ hit }: { hit: ReferenceLine }) {
  if (hit.previewMatchStart < 0 || hit.previewMatchLength === 0) {
    return <span className="references-preview">{hit.preview}</span>;
  }
  const start = hit.previewMatchStart;
  const end = start + hit.previewMatchLength;
  return (
    <span className="references-preview">
      {hit.preview.slice(0, start)}
      <mark className="references-match">{hit.preview.slice(start, end)}</mark>
      {hit.preview.slice(end)}
    </span>
  );
}

export function ReferencesPanel() {
  const symbol = useReferencesStore((s) => s.symbol);
  const status = useReferencesStore((s) => s.status);
  const error = useReferencesStore((s) => s.error);
  const groups = useReferencesStore((s) => s.groups);
  const collapsed = useReferencesStore((s) => s.collapsed);
  const filter = useReferencesStore((s) => s.filter);
  const setFilter = useReferencesStore((s) => s.setFilter);
  const toggleCollapsed = useReferencesStore((s) => s.toggleCollapsed);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  // Deferred so typing in the filter never blocks on re-rendering a long list.
  const deferredFilter = useDeferredValue(filter);

  const visible = useMemo(() => {
    const needle = deferredFilter.trim().toLowerCase();
    if (!needle) return groups;
    return groups
      .map((group) => {
        // A file whose NAME matches keeps all of its hits — otherwise filtering
        // by filename would hide the very hits you were looking for.
        if (group.path.toLowerCase().includes(needle)) return group;
        const hits = group.hits.filter((h) => h.preview.toLowerCase().includes(needle));
        return hits.length ? { ...group, hits } : null;
      })
      .filter((g): g is (typeof groups)[number] => g !== null);
  }, [groups, deferredFilter]);

  const total = visible.reduce((n, g) => n + g.hits.length, 0);

  async function openHit(hit: ReferenceLine) {
    recordJumpOrigin();
    setPendingNavigation({ line: hit.line, column: hit.column, highlight: true });
    await useWorkspaceStore
      .getState()
      .openFile(hit.path, hit.path.split('/').pop() || hit.path);
  }

  if (status === 'idle') {
    return (
      <div className="references-panel">
        <div className="references-empty">
          Put the caret on a symbol and press <kbd>⌥F7</kbd> to find its usages.
        </div>
      </div>
    );
  }

  if (status === 'loading') {
    return (
      <div className="references-panel">
        <div className="references-empty">
          <LoaderCircle size={14} className="references-spinner" />
          Finding usages of <strong>{symbol}</strong>…
        </div>
      </div>
    );
  }

  if (status === 'error') {
    // Deliberately distinct from the empty state below: "nothing uses this" and
    // "we could not find out" would otherwise look the same, and only one of
    // them means it is safe to delete the symbol.
    return (
      <div className="references-panel">
        <div className="references-empty references-error">{error}</div>
      </div>
    );
  }

  return (
    <div className="references-panel">
      <div className="references-header">
        <span className="references-title">
          {groups.length === 0 ? (
            <>
              No usages of <strong>{symbol}</strong>
            </>
          ) : (
            <>
              <strong>{symbol}</strong> — {total} {total === 1 ? 'usage' : 'usages'} in{' '}
              {visible.length} {visible.length === 1 ? 'file' : 'files'}
            </>
          )}
        </span>
        {groups.length > 0 && (
          <input
            className="references-filter"
            type="text"
            value={filter}
            placeholder="Filter usages"
            aria-label="Filter usages"
            onChange={(e) => setFilter(e.target.value)}
          />
        )}
      </div>

      <div className="references-list">
        {groups.length > 0 && visible.length === 0 && (
          <div className="references-empty">No usages match “{filter}”.</div>
        )}
        {visible.map((group) => {
          const isCollapsed = collapsed.has(group.path);
          const relPath = workspacePath
            ? group.path.replace(workspacePath + '/', '')
            : group.path;
          return (
            <div key={group.path} className="references-file-group">
              <button
                className="references-file-header"
                onClick={() => toggleCollapsed(group.path)}
                aria-expanded={!isCollapsed}
                title={group.path}
              >
                {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                <File size={13} className="references-file-icon" />
                <span className="references-file-name">{group.name}</span>
                <span className="references-file-path">
                  {relPath !== group.name ? relPath : ''}
                </span>
                <span className="references-file-count">{group.hits.length}</span>
              </button>
              {!isCollapsed && (
                <div className="references-hit-list">
                  {group.hits.map((hit) => (
                    <button
                      key={`${hit.line}:${hit.column}`}
                      className="references-hit"
                      onClick={() => void openHit(hit)}
                      title={`${relPath}:${hit.line}`}
                    >
                      <span className="references-line-no">{hit.line}</span>
                      <Preview hit={hit} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default ReferencesPanel;
