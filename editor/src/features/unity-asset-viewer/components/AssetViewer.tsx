import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChevronRight, ChevronDown, Box, FileCode, Code2, Pencil } from 'lucide-react';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useUnityIndexStore } from '../../../stores/unity-index';
import type {
  UnityAssetModel,
  SceneGameObject,
  SceneComponentRef,
  UnityYamlDocument,
} from '../services/asset-model';
import { extractGuid } from '../services/asset-model';

interface Props {
  path: string;
  name: string;
  onViewRaw: () => void;
  onEditRaw: () => void;
}

/** Resolve a (possibly project-relative) index path to absolute and open it. */
function openByPath(path: string) {
  const ws = useWorkspaceStore.getState().workspacePath;
  const abs =
    path.startsWith('/') || /^[A-Za-z]:/.test(path)
      ? path
      : ws
        ? (ws.endsWith('/') ? ws : ws + '/') + path
        : path;
  const fileName = abs.split('/').pop() || abs;
  void useWorkspaceStore.getState().openFile(abs, fileName);
}

/**
 * A clickable guid reference — resolves to an asset path via the GUID index.
 * Exported for reuse by `SceneDiffViewer` (same feature folder), which needs
 * the identical guid→link rendering for scene-diff property/reference rows.
 */
export function GuidRef({ guid, label }: { guid: string; label?: string }) {
  const [resolved, setResolved] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void useUnityIndexStore
      .getState()
      .resolveGuid(guid)
      .then((p) => {
        if (!cancelled) setResolved(p);
      });
    return () => {
      cancelled = true;
    };
  }, [guid]);

  if (!resolved) {
    return (
      <span style={{ color: 'var(--text-secondary)' }} title={guid}>
        {label ?? `guid:${guid.slice(0, 8)}…`}
      </span>
    );
  }
  const base = resolved.split('/').pop() || resolved;
  return (
    <a
      title={resolved}
      onClick={() => openByPath(resolved)}
      style={{ color: 'var(--accent, #4ec9b0)', cursor: 'pointer', textDecoration: 'underline' }}
    >
      {label ?? base}
    </a>
  );
}

function ComponentRow({ comp, depth }: { comp: SceneComponentRef; depth: number }) {
  const style: React.CSSProperties = {
    paddingLeft: depth * 14 + 26,
    fontSize: 12.5,
    color: 'var(--text-secondary)',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    height: 22,
  };
  if (comp.scriptGuid) {
    return (
      <div style={style}>
        <FileCode size={12} style={{ flexShrink: 0, opacity: 0.7 }} />
        <GuidRef guid={comp.scriptGuid} label={comp.typeName} />
      </div>
    );
  }
  return (
    <div style={style} title={`classId ${comp.classId}`}>
      <FileCode size={12} style={{ flexShrink: 0, opacity: 0.4 }} />
      <span>{comp.typeName}</span>
    </div>
  );
}

function GoNode({
  go,
  depth,
  expanded,
  toggle,
}: {
  go: SceneGameObject;
  depth: number;
  expanded: Set<string>;
  toggle: (id: string) => void;
}) {
  const hasDetail = go.children.length > 0 || go.components.length > 0;
  const isOpen = expanded.has(go.fileId);
  return (
    <>
      <div
        style={{
          paddingLeft: depth * 14 + 4,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          height: 22,
          fontSize: 13,
          cursor: hasDetail ? 'pointer' : 'default',
          opacity: go.isActive ? 1 : 0.5,
        }}
        onClick={() => hasDetail && toggle(go.fileId)}
        title={`tag: ${go.tag}, layer: ${go.layer}`}
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
        <span>{go.name}</span>
      </div>
      {isOpen && (
        <>
          {go.components.map((c, i) => (
            <ComponentRow key={`c${i}`} comp={c} depth={depth + 1} />
          ))}
          {go.children.map((ch) => (
            <GoNode key={ch.fileId} go={ch} depth={depth + 1} expanded={expanded} toggle={toggle} />
          ))}
        </>
      )}
    </>
  );
}

function PropValue({ value }: { value: string }) {
  const guid = extractGuid(value);
  if (guid) return <GuidRef guid={guid} />;
  const v = value.length > 200 ? value.slice(0, 200) + '…' : value;
  return <span style={{ color: 'var(--text-primary)' }}>{v}</span>;
}

function DocBlock({ doc }: { doc: UnityYamlDocument }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ marginBottom: 8 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 8px',
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
        }}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{doc.typeName}</span>
        {doc.scriptGuid && (
          <span style={{ fontWeight: 400, fontSize: 11 }}>
            (<GuidRef guid={doc.scriptGuid} />)
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-secondary)' }}>
          &amp;{doc.fileId}
        </span>
      </div>
      {open && doc.properties.length > 0 && (
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
          <tbody>
            {doc.properties.map(([k, v], i) => (
              <tr key={i}>
                <td
                  style={{
                    padding: '1px 8px 1px 26px',
                    color: 'var(--text-secondary)',
                    verticalAlign: 'top',
                    whiteSpace: 'nowrap',
                    width: '1%',
                  }}
                >
                  {k}
                </td>
                <td style={{ padding: '1px 8px', wordBreak: 'break-word' }}>
                  <PropValue value={v} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * Structured read-only viewer for Unity YAML assets (scenes/prefabs/.asset/.mat)
 * via the Rust `unity_parse_asset` parser (F-3.2 T7.2). GameObject hierarchy +
 * component/property trees, with `{guid}` references rendered as clickable links
 * resolved through the GUID index. "View raw" / "Edit raw" toggle out to Monaco.
 */
export function AssetViewer({ path, name, onViewRaw, onEditRaw }: Props) {
  const [model, setModel] = useState<UnityAssetModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setModel(null);
    setError(null);
    void invoke<UnityAssetModel>('unity_parse_asset', { path })
      .then((m) => {
        if (!cancelled) setModel(m);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  return (
    <div className="editor-container" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 10px',
          borderBottom: '1px solid var(--border)',
          fontSize: 12,
          color: 'var(--text-secondary)',
          flexShrink: 0,
        }}
      >
        <Box size={14} />
        <span style={{ color: 'var(--text-primary)' }}>{name}</span>
        <span style={{ opacity: 0.7 }}>structured view</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button className="asset-viewer-btn" onClick={onViewRaw} title="Show the raw YAML (read-only)">
            <Code2 size={13} /> View Raw
          </button>
          <button className="asset-viewer-btn" onClick={onEditRaw} title="Edit the raw YAML — editing scene/prefab YAML by hand is risky">
            <Pencil size={13} /> Edit Raw
          </button>
        </div>
      </div>
      <div style={{ overflow: 'auto', flex: 1, padding: '6px 0' }}>
        {error ? (
          <div style={{ padding: 16, color: 'var(--error-text)', fontSize: 13 }}>
            Failed to parse asset: {error}
            <div style={{ marginTop: 8 }}>
              <button className="asset-viewer-btn" onClick={onViewRaw}>
                View Raw
              </button>
            </div>
          </div>
        ) : !model ? (
          <div style={{ padding: 16, color: 'var(--text-secondary)', fontSize: 13 }}>Parsing…</div>
        ) : model.gameObjects.length > 0 ? (
          model.gameObjects.map((go) => (
            <GoNode key={go.fileId} go={go} depth={0} expanded={expanded} toggle={toggle} />
          ))
        ) : model.documents.length > 0 ? (
          model.documents.map((doc, i) => <DocBlock key={i} doc={doc} />)
        ) : (
          <div style={{ padding: 16, color: 'var(--text-secondary)', fontSize: 13 }}>
            No structured content. <button className="asset-viewer-btn" onClick={onViewRaw}>View Raw</button>
          </div>
        )}
      </div>
    </div>
  );
}

export default AssetViewer;
