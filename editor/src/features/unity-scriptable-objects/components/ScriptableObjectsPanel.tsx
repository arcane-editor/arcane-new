import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  ChevronDown,
  ChevronRight,
  Boxes,
  Box,
  FileCode2,
  LoaderCircle,
  Search,
  RefreshCw,
} from 'lucide-react';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useProjectContextStore } from '../../../stores/project-context';
import { useUnityIndexStore } from '../../../stores/unity-index';

/** One ScriptableObject class and every asset instancing it. */
interface SoTypeGroup {
  scriptGuid: string;
  scriptPath: string | null;
  typeName: string;
  instances: Array<{ path: string; name: string }>;
}

/**
 * The project's ScriptableObjects, grouped by type.
 *
 * The Explorer shows a folder tree; this shows the same assets organised the
 * way a designer thinks about them — "all the weapons", not "everything under
 * Assets/Data/Combat". Types with no instances are absent: a `[CreateAssetMenu]`
 * class nobody has instanced has nothing to browse.
 */
function ScriptableObjectsPanel() {
  const isUnityProject = useProjectContextStore((s) => s.isUnityProject);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const openFile = useWorkspaceStore((s) => s.openFile);

  // Two triggers, not one: `status` covers a full (re)build and `indexRevision`
  // covers incremental deltas, which leave status untouched. Watching only one
  // leaves this list stale until the app restarts.
  const indexStatus = useUnityIndexStore((s) => s.status);
  const indexRevision = useUnityIndexStore((s) => s.indexRevision);

  const [groups, setGroups] = useState<SoTypeGroup[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const deferred = useDeferredValue(filter);

  const load = useCallback(async () => {
    if (!isUnityProject || !workspacePath) {
      setGroups(null);
      return;
    }
    setLoading(true);
    try {
      const result = await invoke<SoTypeGroup[]>('unity_scriptable_object_types', {
        workspacePath,
      });
      setGroups(result);
    } catch {
      setGroups([]);
    } finally {
      setLoading(false);
    }
  }, [isUnityProject, workspacePath]);

  useEffect(() => {
    void load();
    // `indexStatus`/`indexRevision` are the invalidation signal, not arguments.
  }, [load, indexStatus, indexRevision]);

  const visible = useMemo(() => {
    const q = deferred.trim().toLowerCase();
    if (!q || !groups) return groups ?? [];
    return groups
      .map((g) => {
        if (g.typeName.toLowerCase().includes(q)) return g;
        const hits = g.instances.filter((i) => i.name.toLowerCase().includes(q));
        return hits.length > 0 ? { ...g, instances: hits } : null;
      })
      .filter((g): g is SoTypeGroup => g !== null);
  }, [groups, deferred]);

  const toggle = (guid: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(guid)) next.delete(guid);
      else next.add(guid);
      return next;
    });

  const totalInstances = useMemo(
    () => (groups ?? []).reduce((n, g) => n + g.instances.length, 0),
    [groups],
  );

  if (!isUnityProject) {
    return <div className="sidebar-empty">Not a Unity project.</div>;
  }

  return (
    <div className="scene-usage-panel">
      <div className="scene-usage-header">
        <span className="scene-usage-title">Scriptable Objects</span>
        <div className="scene-usage-header-actions">
          <button
            className="scene-usage-header-btn"
            title="Rescan"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw size={13} className={loading ? 'so-spin' : undefined} />
          </button>
        </div>
      </div>

      {groups !== null && groups.length > 0 && (
        <div className="scene-usage-subtitle">
          {groups.length} {groups.length === 1 ? 'type' : 'types'} · {totalInstances}{' '}
          {totalInstances === 1 ? 'asset' : 'assets'}
        </div>
      )}

      <div className="scene-usage-search">
        <Search size={14} className="scene-usage-search-icon" />
        <input
          type="text"
          className="scene-usage-search-input"
          placeholder="Filter types or assets..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
        />
      </div>

      {loading && groups === null && (
        <div className="so-instances-empty">
          <LoaderCircle size={20} className="so-spin" strokeWidth={1.5} />
          <span>Scanning assets…</span>
        </div>
      )}

      {groups !== null && groups.length === 0 && !loading && (
        <div className="so-instances-empty">
          <Boxes size={26} strokeWidth={1.25} style={{ opacity: 0.5 }} />
          <div className="so-instances-empty-title">No ScriptableObjects</div>
          <div className="so-instances-empty-hint">
            Assets appear here once a class with <code>[CreateAssetMenu]</code> has been
            instanced in Unity.
          </div>
        </div>
      )}

      <div className="scene-usage-tree">
        {visible.map((group) => {
          const isOpen = expanded.has(group.scriptGuid) || deferred.trim().length > 0;
          return (
            <div key={group.scriptGuid}>
              <div
                className="scene-usage-scene-row"
                onClick={() => toggle(group.scriptGuid)}
                title={group.scriptPath ?? group.scriptGuid}
              >
                {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <Boxes size={13} className="so-type-icon" />
                <span className="scene-usage-scene-name">{group.typeName}</span>
                <span className="scene-usage-ref-badge">{group.instances.length}</span>
              </div>

              {isOpen && (
                <div className="scene-usage-go-group">
                  {group.instances.map((instance) => (
                    <div
                      key={instance.path}
                      className="so-instance-row"
                      title={instance.path}
                      onClick={() => openFile(instance.path, `${instance.name}.asset`)}
                    >
                      <Box size={12} className="so-instance-icon" />
                      <span className="scene-usage-scene-name">{instance.name}</span>
                    </div>
                  ))}
                  {group.scriptPath && (
                    <div
                      className="so-instance-row so-instance-script"
                      title={group.scriptPath}
                      onClick={() => openFile(group.scriptPath!, `${group.typeName}.cs`)}
                    >
                      <FileCode2 size={11} />
                      <span className="scene-usage-scene-name">{group.typeName}.cs</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default ScriptableObjectsPanel;
