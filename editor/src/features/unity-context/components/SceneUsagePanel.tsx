import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { ChevronRight, ChevronDown, Search, LoaderCircle, Layers } from 'lucide-react';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useProjectContextStore } from '../../../stores/project-context';
import { useUnityStore } from '../../../stores/unity';
import { classifyFile, FilePriority } from '../../csharp';
import { useSceneUsageStore } from '../stores/scene-usage';
import type { AssetKind, AssetUsageEntry } from '../services/scene-usage-finder';

function SceneUsagePanel() {
  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const isUnityProject = useProjectContextStore((s) => s.isUnityProject);
  const unityConnected = useUnityStore((s) => s.connected);
  const openFile = useWorkspaceStore((s) => s.openFile);

  const entries = useSceneUsageStore((s) => s.entriesForActiveScript);
  const isLoading = useSceneUsageStore((s) => s.isLoading);
  const loadForScript = useSceneUsageStore((s) => s.loadForScript);
  const instanceUsageCache = useSceneUsageStore((s) => s.instanceUsageCache);
  const instanceUsageLoading = useSceneUsageStore((s) => s.instanceUsageLoading);
  const loadInstanceUsages = useSceneUsageStore((s) => s.loadInstanceUsages);

  const gate = useMemo(() => {
    if (!isUnityProject || !workspacePath || !activeFilePath) return null;
    if (!activeFilePath.toLowerCase().endsWith('.cs')) return null;
    if (activeFilePath.startsWith('diff://') || activeFilePath.startsWith('auth://')) return null;
    const prefix = workspacePath.endsWith('/') ? workspacePath : workspacePath + '/';
    if (!activeFilePath.startsWith(prefix)) return null;
    const rel = activeFilePath.slice(prefix.length);
    if (classifyFile(rel) !== FilePriority.MonoBehaviour) return null;
    return { rel, abs: activeFilePath };
  }, [isUnityProject, workspacePath, activeFilePath]);

  const [filter, setFilter] = useState('');
  const [expandedAssets, setExpandedAssets] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (gate && workspacePath) {
      loadForScript(gate.abs, workspacePath);
    }
  }, [gate, workspacePath, loadForScript]);

  const deferredFilter = useDeferredValue(filter);
  const lowerFilter = deferredFilter.toLowerCase();
  const list = entries ?? [];
  const filtered = deferredFilter
    ? list.filter(
        (s) =>
          s.assetName.toLowerCase().includes(lowerFilter) ||
          s.gameObjects.some((go) => go.name.toLowerCase().includes(lowerFilter)),
      )
    : list;

  const sceneCount = filtered.filter((a) => a.kind === 'scene').length;
  const prefabCount = filtered.filter((a) => a.kind === 'prefab').length;
  const soCount = filtered.filter((a) => a.kind === 'scriptableObject').length;
  const totalGameObjects = filtered
    .filter((a) => a.kind !== 'scriptableObject')
    .reduce((sum, s) => sum + s.gameObjects.length, 0);

  const grouped = useMemo(() => {
    const scenes = filtered.filter((a) => a.kind === 'scene');
    const prefabs = filtered.filter((a) => a.kind === 'prefab');
    const scriptableObjects = filtered.filter((a) => a.kind === 'scriptableObject');
    const sections: { kind: AssetKind; items: AssetUsageEntry[] }[] = [];
    if (scenes.length) sections.push({ kind: 'scene', items: scenes });
    if (prefabs.length) sections.push({ kind: 'prefab', items: prefabs });
    if (scriptableObjects.length) sections.push({ kind: 'scriptableObject', items: scriptableObjects });
    return sections;
  }, [filtered]);

  const toggleAsset = (asset: AssetUsageEntry) => {
    setExpandedAssets((prev) => {
      const next = new Set(prev);
      if (next.has(asset.assetPath)) {
        next.delete(asset.assetPath);
      } else {
        next.add(asset.assetPath);
        // Trigger lazy level-2 scan for SO instances on first expand.
        if (
          asset.kind === 'scriptableObject' &&
          asset.isInstance &&
          asset.assetGuid &&
          workspacePath &&
          !instanceUsageCache.has(asset.assetGuid)
        ) {
          loadInstanceUsages(asset.assetGuid, workspacePath);
        }
      }
      return next;
    });
  };

  const handleOpenAsset = (assetPath: string) => {
    const name = assetPath.split('/').pop() ?? assetPath;
    openFile(assetPath, name);
  };

  const sectionLabel = (kind: AssetKind, count: number): string => {
    if (kind === 'scene') return `Scenes · ${count}`;
    if (kind === 'prefab') return `Prefabs · ${count}`;
    return `ScriptableObjects · ${count}`;
  };

  return (
    <div className="scene-usage-panel">
      <div className="scene-usage-header">
        <span className="scene-usage-title">ASSET USAGE</span>
      </div>

      {!gate && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            padding: '40px 24px',
            color: 'var(--text-secondary)',
            textAlign: 'center',
          }}
        >
          <Layers size={28} strokeWidth={1.25} style={{ opacity: 0.5 }} />
          <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>
            No script selected
          </div>
          <div style={{ fontSize: 11, lineHeight: 1.5, maxWidth: 240 }}>
            Open a MonoBehaviour or ScriptableObject script to see which scenes, prefabs, and assets reference it.
          </div>
        </div>
      )}

      {gate && (
        <div className="scene-usage-subtitle">
          {isLoading
            ? 'Scanning scenes, prefabs, and assets…'
            : filtered.length === 0 && !unityConnected
            ? 'Unity not connected — usage may be incomplete.'
            : `Found in ${sceneCount} ${sceneCount === 1 ? 'scene' : 'scenes'}, ${prefabCount} ${prefabCount === 1 ? 'prefab' : 'prefabs'}, ${soCount} ${soCount === 1 ? 'scriptable object' : 'scriptable objects'} (${totalGameObjects} GameObjects)`}
        </div>
      )}

      {gate && (
        <div className="scene-usage-search">
          <Search size={14} className="scene-usage-search-icon" />
          <input
            type="text"
            placeholder="Filter by asset or gameobject..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="scene-usage-search-input"
            aria-label="Filter assets or game objects"
          />
        </div>
      )}

      {gate && isLoading && (
        <div className="scene-usage-loading" style={{ padding: '12px', display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)', fontSize: 12 }}>
          <LoaderCircle size={14} className="animate-spin" />
          <span>Scanning scenes, prefabs, and assets…</span>
        </div>
      )}

      {gate && !isLoading && filtered.length === 0 && (
        <div className="scene-usage-empty" style={{ padding: '12px', color: 'var(--text-secondary)', fontSize: 12 }}>
          {entries === null
            ? 'Loading…'
            : list.length === 0
            ? unityConnected
              ? 'Not used in any scenes, prefabs, or scriptable objects.'
              : 'No references found in saved scenes, prefabs, or assets. Connect the Unity Editor for complete, live usage data.'
            : 'No matches.'}
        </div>
      )}

      {gate && !isLoading && filtered.length > 0 && (
        <div className="scene-usage-tree">
          {grouped.map((section) => (
            <div key={section.kind}>
              <div
                className="scene-usage-section-header"
                style={{
                  padding: '6px 8px 4px',
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: '0.05em',
                  color: 'var(--text-secondary)',
                  textTransform: 'uppercase',
                }}
              >
                {sectionLabel(section.kind, section.items.length)}
              </div>
              {section.items.map((asset) => {
                if (asset.kind === 'scriptableObject') {
                  return (
                    <ScriptableObjectRow
                      key={asset.assetPath}
                      asset={asset}
                      expanded={expandedAssets.has(asset.assetPath)}
                      onToggle={() => toggleAsset(asset)}
                      onOpenAsset={handleOpenAsset}
                      instanceUsageCache={instanceUsageCache}
                      instanceUsageLoading={instanceUsageLoading}
                    />
                  );
                }

                const isExpanded = expandedAssets.has(asset.assetPath);
                return (
                  <div key={asset.assetPath}>
                    <div
                      className="scene-usage-scene-row"
                      onClick={() => toggleAsset(asset)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggleAsset(asset);
                        }
                      }}
                    >
                      {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      <span className="scene-usage-scene-icon" />
                      <span
                        className="scene-usage-scene-name"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleOpenAsset(asset.assetPath);
                        }}
                        title={asset.assetPath}
                        style={{ cursor: 'pointer' }}
                      >
                        {asset.assetName}
                      </span>
                      <span className="scene-usage-ref-badge">
                        {asset.refCount} {asset.refCount === 1 ? 'REF' : 'REFS'}
                      </span>
                    </div>

                    {isExpanded &&
                      asset.gameObjects.map((go) => (
                        <div key={go.fileId} className="scene-usage-go-group">
                          <div className="scene-usage-go-row">
                            <span className="scene-usage-go-icon" />
                            <span>{go.name}</span>
                          </div>
                          {go.fields.map((prop) => (
                            <div key={`${go.fileId}-${prop.label}`} className="scene-usage-prop-row">
                              <span className="scene-usage-prop-label">{prop.label}</span>
                              <span className="scene-usage-prop-value">{prop.value}</span>
                            </div>
                          ))}
                        </div>
                      ))}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface ScriptableObjectRowProps {
  asset: AssetUsageEntry;
  expanded: boolean;
  onToggle: () => void;
  onOpenAsset: (path: string) => void;
  instanceUsageCache: Map<string, AssetUsageEntry[]>;
  instanceUsageLoading: Set<string>;
}

function ScriptableObjectRow({
  asset,
  expanded,
  onToggle,
  onOpenAsset,
  instanceUsageCache,
  instanceUsageLoading,
}: ScriptableObjectRowProps) {
  // Plain reference (not an instance of the open script): flat row only.
  if (!asset.isInstance) {
    return (
      <div className="scene-usage-scene-row" style={{ cursor: 'default' }}>
        <span style={{ width: 14 }} />
        <span className="scene-usage-scene-icon" />
        <span
          className="scene-usage-scene-name"
          onClick={(e) => {
            e.stopPropagation();
            onOpenAsset(asset.assetPath);
          }}
          title={asset.assetPath}
          style={{ cursor: 'pointer' }}
        >
          {asset.assetName}
        </span>
        <span className="scene-usage-ref-badge">REF</span>
      </div>
    );
  }

  const usages = asset.assetGuid ? instanceUsageCache.get(asset.assetGuid) : undefined;
  const isScanning = !!asset.assetGuid && instanceUsageLoading.has(asset.assetGuid);
  const badge = usages
    ? `${usages.length} ${usages.length === 1 ? 'USAGE' : 'USAGES'}`
    : isScanning
    ? 'SCANNING…'
    : '… CLICK TO SCAN';

  return (
    <div>
      <div
        className="scene-usage-scene-row"
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="scene-usage-scene-icon" />
        <span
          className="scene-usage-scene-name"
          onClick={(e) => {
            e.stopPropagation();
            onOpenAsset(asset.assetPath);
          }}
          title={asset.assetPath}
          style={{ cursor: 'pointer' }}
        >
          {asset.assetName}
        </span>
        <span className="scene-usage-ref-badge">{badge}</span>
      </div>

      {expanded && (
        <>
          {isScanning && (
            <div
              className="scene-usage-loading"
              style={{ padding: '6px 28px', display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)', fontSize: 11 }}
            >
              <LoaderCircle size={12} className="animate-spin" />
              <span>Scanning usages…</span>
            </div>
          )}

          {!isScanning && usages && usages.length === 0 && (
            <div
              style={{ padding: '6px 28px', color: 'var(--text-secondary)', fontSize: 11 }}
            >
              Not referenced anywhere.
            </div>
          )}

          {!isScanning &&
            usages &&
            usages.map((usage) => (
              <div key={usage.assetPath} className="scene-usage-go-group">
                <div
                  className="scene-usage-go-row"
                  onClick={() => onOpenAsset(usage.assetPath)}
                  style={{ cursor: 'pointer' }}
                  title={usage.assetPath}
                >
                  <span className="scene-usage-go-icon" />
                  <span>{usage.assetName}</span>
                </div>
                {usage.gameObjects.map((go) => (
                  <div
                    key={`${usage.assetPath}-${go.fileId}`}
                    className="scene-usage-prop-row"
                  >
                    <span className="scene-usage-prop-label">{go.name}</span>
                  </div>
                ))}
              </div>
            ))}
        </>
      )}
    </div>
  );
}

export default SceneUsagePanel;
