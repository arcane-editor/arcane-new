import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChevronRight, ChevronDown, Box, Layers, Copy, FileCode } from 'lucide-react';
import { useWorkspaceStore } from '../../../stores/workspace';
import { parseSceneFile, type SceneGameObject, type SceneComponent } from '../services/scene-parser';
import { resolveGuid, scanMetaFiles, isScanned } from '../services/guid-resolver';

function SceneContextPanel() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const [sceneFiles, setSceneFiles] = useState<string[]>([]);
  const [selectedScene, setSelectedScene] = useState<string | null>(null);
  const [rootObjects, setRootObjects] = useState<SceneGameObject[]>([]);
  const [loading, setLoading] = useState(false);

  // Scan for scene files and meta files on mount
  useEffect(() => {
    if (!workspacePath) return;

    // Scan meta files for GUID resolution
    if (!isScanned()) {
      scanMetaFiles(workspacePath);
    }

    // Find .unity and .prefab files
    invoke<string[]>('scan_all_files_v2', {
      workspacePath,
      extraExcludes: [] as string[],
    }).then((files) => {
      const scenes = files.filter(
        (f) => f.endsWith('.unity') || f.endsWith('.prefab'),
      );
      setSceneFiles(scenes);
    }).catch(() => {});
  }, [workspacePath]);

  // Parse selected scene
  const loadScene = useCallback(async (scenePath: string) => {
    setLoading(true);
    setSelectedScene(scenePath);
    try {
      const content = await invoke<string>('read_file', { path: scenePath });
      const graph = parseSceneFile(content);
      setRootObjects(graph.rootObjects);
    } catch (err) {
      console.warn('[SceneContext] Failed to parse scene:', err);
      setRootObjects([]);
    }
    setLoading(false);
  }, []);

  return (
    <div style={{ height: '100%', overflow: 'auto', fontSize: 12 }}>
      <div style={{
        padding: '8px 12px',
        fontWeight: 600,
        fontSize: 11,
        textTransform: 'uppercase',
        color: 'var(--text-secondary)',
        letterSpacing: '0.5px',
      }}>
        Scene Context
      </div>

      {/* Scene file list */}
      <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: 4 }}>
        {sceneFiles.length === 0 && (
          <div style={{ padding: '4px 12px', color: 'var(--text-secondary)' }}>
            No scene files found
          </div>
        )}
        {sceneFiles.map((sf) => {
          const name = sf.split('/').pop() ?? sf;
          const isSelected = sf === selectedScene;
          return (
            <div
              key={sf}
              onClick={() => loadScene(sf)}
              style={{
                padding: '3px 12px',
                cursor: 'pointer',
                background: isSelected ? 'var(--hover)' : 'transparent',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <Layers size={12} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {name}
              </span>
            </div>
          );
        })}
      </div>

      {/* Scene hierarchy */}
      {loading && (
        <div style={{ padding: '8px 12px', color: 'var(--text-secondary)' }}>
          Parsing scene...
        </div>
      )}

      {!loading && selectedScene && rootObjects.length === 0 && (
        <div style={{ padding: '8px 12px', color: 'var(--text-secondary)' }}>
          No GameObjects found
        </div>
      )}

      {!loading && rootObjects.map((go) => (
        <GameObjectNode key={go.fileId} go={go} depth={0} />
      ))}
    </div>
  );
}

function GameObjectNode({ go, depth }: { go: SceneGameObject; depth: number }) {
  const [expanded, setExpanded] = useState(depth < 2);
  const openFile = useWorkspaceStore((s) => s.openFile);
  const hasChildren = go.children.length > 0 || go.components.length > 0;

  return (
    <div>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '2px 8px',
          paddingLeft: 12 + depth * 16,
          cursor: hasChildren ? 'pointer' : 'default',
          color: go.isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
        }}
      >
        {hasChildren ? (
          expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />
        ) : (
          <span style={{ width: 12 }} />
        )}
        <Box size={12} style={{ color: 'var(--info)', flexShrink: 0 }} />
        <span style={{ fontWeight: 500 }}>{go.name}</span>
        {go.tag !== 'Untagged' && (
          <span style={{ color: 'var(--text-secondary)', fontSize: 10, marginLeft: 4 }}>
            [{go.tag}]
          </span>
        )}
      </div>

      {expanded && (
        <>
          {go.components.map((comp) => (
            <ComponentNode
              key={comp.fileId}
              comp={comp}
              depth={depth + 1}
              openFile={openFile}
            />
          ))}
          {go.children.map((child) => (
            <GameObjectNode key={child.fileId} go={child} depth={depth + 1} />
          ))}
        </>
      )}
    </div>
  );
}

function ComponentNode({
  comp,
  depth,
  openFile,
}: {
  comp: SceneComponent;
  depth: number;
  openFile: (path: string, name: string) => Promise<void>;
}) {
  const isScript = comp.classId === '114' && comp.scriptGuid;
  const resolvedPath = isScript ? resolveGuid(comp.scriptGuid!) : undefined;

  const handleClick = () => {
    if (resolvedPath) {
      const name = resolvedPath.split('/').pop() ?? resolvedPath;
      openFile(resolvedPath, name);
    }
  };

  const handleCopyGuid = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (comp.scriptGuid) {
      navigator.clipboard.writeText(comp.scriptGuid);
    }
  };

  return (
    <div
      onClick={isScript ? handleClick : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '1px 8px',
        paddingLeft: 12 + (depth + 1) * 16,
        cursor: isScript ? 'pointer' : 'default',
        color: 'var(--text-secondary)',
        fontSize: 11,
      }}
    >
      <FileCode size={10} style={{ flexShrink: 0 }} />
      <span>{comp.typeName}</span>
      {isScript && comp.scriptGuid && (
        <button
          title="Copy GUID"
          onClick={handleCopyGuid}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            padding: 0,
            marginLeft: 'auto',
          }}
        >
          <Copy size={10} />
        </button>
      )}
    </div>
  );
}

export default SceneContextPanel;
