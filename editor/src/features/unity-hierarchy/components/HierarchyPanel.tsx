import { useEffect, useState, useCallback } from 'react';
import { ChevronRight, ChevronDown, RefreshCw, Box, Plug, Unplug } from 'lucide-react';
import { useUnitySceneStore } from '../../../stores/unity-scene';
import { useUnityStore } from '../../../stores/unity';
import type { HierarchyNode } from '../../unity-bridge';
import { openScriptForType } from '../services/open-script';

const ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  height: 22,
  fontSize: 13,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  color: 'var(--text-primary)',
};

function ComponentRow({ type, depth }: { type: string; depth: number }) {
  return (
    <div
      style={{ ...ROW, paddingLeft: depth * 14 + 26, color: 'var(--text-secondary)' }}
      title={`Open ${type}.cs (if it's a script)`}
      onClick={(e) => {
        e.stopPropagation();
        void openScriptForType(type);
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <Plug size={12} style={{ flexShrink: 0, opacity: 0.7 }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{type}</span>
    </div>
  );
}

interface NodeRowProps {
  node: HierarchyNode;
  depth: number;
  expanded: Set<number>;
  toggle: (id: number) => void;
}

function NodeRow({ node, depth, expanded, toggle }: NodeRowProps) {
  const hasDetail = node.children.length > 0 || node.components.length > 0;
  const isOpen = expanded.has(node.instanceId);
  return (
    <>
      <div
        style={{ ...ROW, paddingLeft: depth * 14 + 4, opacity: node.active ? 1 : 0.5 }}
        onClick={() => hasDetail && toggle(node.instanceId)}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        title={`${node.name}  [tag: ${node.tag}, layer: ${node.layer}]`}
      >
        {hasDetail ? (
          isOpen ? (
            <ChevronDown size={12} style={{ flexShrink: 0 }} />
          ) : (
            <ChevronRight size={12} style={{ flexShrink: 0 }} />
          )
        ) : (
          <span style={{ width: 12, flexShrink: 0 }} />
        )}
        <Box size={13} style={{ flexShrink: 0, color: 'var(--accent, #4ec9b0)' }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</span>
        {node.components.length > 0 && (
          <span style={{ fontSize: 10, color: 'var(--text-secondary)', marginLeft: 'auto', paddingRight: 6 }}>
            {node.components.length}
          </span>
        )}
      </div>
      {isOpen && (
        <>
          {node.components.map((c, i) => (
            <ComponentRow key={`c${i}`} type={c.type} depth={depth + 1} />
          ))}
          {node.children.map((ch) => (
            <NodeRow key={ch.instanceId} node={ch} depth={depth + 1} expanded={expanded} toggle={toggle} />
          ))}
        </>
      )}
    </>
  );
}

/**
 * Live scene hierarchy mirroring the connected Unity Editor (F-4.3). Read-only
 * tree; clicking a component opens its script. Degrades to a clear empty state
 * when Unity isn't connected.
 */
export function HierarchyPanel() {
  const hierarchy = useUnitySceneStore((s) => s.hierarchy);
  const loading = useUnitySceneStore((s) => s.loading);
  const connected = useUnityStore((s) => s.connected);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  useEffect(() => {
    const store = useUnitySceneStore.getState();
    void store.setupListeners();
    void store.refresh();
    return () => store.teardownListeners();
  }, []);

  const toggle = useCallback((id: number) => {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);

  return (
    <div className="sidebar">
      <div className="explorer-header">
        <span className="explorer-header-title">Hierarchy</span>
        <div className="explorer-header-actions">
          <button
            className="explorer-action-btn"
            title="Refresh Hierarchy"
            onClick={() => void useUnitySceneStore.getState().refresh()}
          >
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </div>
      <div className="sidebar-tree" style={{ overflow: 'auto' }}>
        {!connected ? (
          <div
            style={{
              padding: 16,
              color: 'var(--text-secondary)',
              fontSize: 12,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 8,
              textAlign: 'center',
            }}
          >
            <Unplug size={20} />
            <div>Unity Editor not connected.</div>
            <div style={{ opacity: 0.8 }}>
              Open this project in Unity with the bridge installed to mirror its live hierarchy here.
            </div>
          </div>
        ) : !hierarchy ? (
          <div style={{ padding: 12, color: 'var(--text-secondary)', fontSize: 12 }}>Loading…</div>
        ) : hierarchy.scenes.length === 0 ? (
          <div style={{ padding: 12, color: 'var(--text-secondary)', fontSize: 12 }}>No open scenes.</div>
        ) : (
          <>
            {hierarchy.scenes.map((scene) => (
              <div key={scene.path || scene.name}>
                <div
                  style={{
                    fontSize: 11,
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                    color: 'var(--text-secondary)',
                    padding: '6px 8px 2px',
                  }}
                >
                  {scene.name}
                </div>
                {scene.roots.map((r) => (
                  <NodeRow key={r.instanceId} node={r} depth={0} expanded={expanded} toggle={toggle} />
                ))}
              </div>
            ))}
            {hierarchy.truncated && (
              <div style={{ padding: '6px 8px', fontSize: 11, color: 'var(--warning)' }}>
                Hierarchy truncated (large scene).
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default HierarchyPanel;
