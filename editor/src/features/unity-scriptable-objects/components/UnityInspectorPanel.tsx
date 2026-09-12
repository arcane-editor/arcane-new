import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useProjectContextStore } from '../../../stores/project-context';
import { useSettingsStore } from '../../../stores/settings';
import { classifyFile, FilePriority } from '../../csharp';
import { buildSoSchema, scanCSharp } from '../../unity-analyzers';
import { SceneUsagePanel, useSceneUsageStore } from '../../unity-context';
import { inspectorView, scriptPathGate } from '../services/so-inspector-gate';
import { instanceRows } from '../services/so-instance-columns';
import InspectorTabs from './InspectorTabs';
import SoInstancesTab from './SoInstancesTab';
import SoDriftTab from './SoDriftTab';
import { computeDrift, type DriftFinding } from '../services/so-drift';
import type { SoAssetSnapshot } from '../services/asset-fields-client';

/**
 * The `unity-inspector` view of the right sidebar.
 *
 * Asks one question — is the open script a ScriptableObject? — and answers it
 * in one of two ways:
 *
 *  • MonoBehaviour (or anything unrecognised with no instances on disk): render
 *    `SceneUsagePanel` exactly as before. This path must stay byte-identical to
 *    the old behaviour, which is why it delegates rather than reimplements.
 *  • ScriptableObject: the useful question inverts. "Where is this used" gives
 *    way to "what are the values", so instances lead and usages move to a tab.
 */
function UnityInspectorPanel() {
  const isUnityProject = useProjectContextStore((s) => s.isUnityProject);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);
  const openFiles = useWorkspaceStore((s) => s.openFiles);
  const enabled = useSettingsStore((s) => s.getSetting('unity.scriptableObjects.inspector'));

  const entries = useSceneUsageStore((s) => s.entriesForActiveScript);
  const isLoading = useSceneUsageStore((s) => s.isLoading);
  const loadForScript = useSceneUsageStore((s) => s.loadForScript);

  const [activeTab, setActiveTab] = useState<'instances' | 'usages' | 'drift'>('instances');
  const [drift, setDrift] = useState<DriftFinding[]>([]);
  const [hashes, setHashes] = useState<Map<string, string>>(new Map());
  const [driftLoading, setDriftLoading] = useState(false);
  const [driftToken, setDriftToken] = useState(0);

  const gate = useMemo(
    () =>
      scriptPathGate({
        isUnityProject,
        workspacePath,
        activeFilePath,
        isRuntimeScript: (rel) => classifyFile(rel) === FilePriority.MonoBehaviour,
      }),
    [isUnityProject, workspacePath, activeFilePath],
  );

  // The active file is open by definition, so its buffer is the freshest source
  // — fresher than disk while the user is typing.
  const source = useMemo(
    () => (gate ? openFiles.find((f) => f.path === gate.abs)?.content ?? null : null),
    [gate, openFiles],
  );

  const schema = useMemo(() => (source ? buildSoSchema(scanCSharp(source)) : null), [source]);

  // Both tabs read from the usage store, so the load has to be issued here
  // rather than inside `SceneUsagePanel` — otherwise nothing loads until the
  // user visits the Usages tab.
  useEffect(() => {
    if (gate && workspacePath) void loadForScript(gate.abs, workspacePath);
  }, [gate, workspacePath, loadForScript]);

  const instances = useMemo(() => instanceRows(entries), [entries]);

  const instancePaths = useMemo(
    () => instances.map((i) => i.assetPath).join('\n'),
    [instances],
  );

  // Drift needs every instance READ, not just listed, so it runs once per
  // (class, instance set) rather than on every render. One batch command
  // instead of N invokes — a 40-weapon type would otherwise be 40 IPC hops.
  useEffect(() => {
    if (!schema || instancePaths.length === 0) {
      setDrift([]);
      setHashes(new Map());
      return;
    }
    let cancelled = false;
    setDriftLoading(true);
    const paths = instancePaths.split('\n');
    void invoke<Array<{ path: string; snapshot: SoAssetSnapshot }>>('unity_asset_read_many', {
      paths,
    })
      .then((read) => {
        if (cancelled) return;
        setHashes(new Map(read.map((r) => [r.path, r.snapshot.sha1])));
        setDrift(
          computeDrift({
            schema,
            instances: read.map((r) => ({
              path: r.path,
              name: r.path.split('/').pop()?.replace(/\.asset$/i, '') ?? r.path,
              snapshot: r.snapshot,
            })),
          }),
        );
      })
      .catch(() => {
        if (!cancelled) setDrift([]);
      })
      .finally(() => {
        if (!cancelled) setDriftLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [schema, instancePaths, driftToken]);

  const reloadDrift = useCallback(() => setDriftToken((n) => n + 1), []);

  if (!enabled || !gate || !schema) return <SceneUsagePanel />;

  if (inspectorView(schema.baseKind, instances.length) === 'sceneUsage') {
    return <SceneUsagePanel />;
  }

  const usageCount = (entries ?? []).filter((e) => e.kind !== 'scriptableObject').length;

  return (
    <div className="scene-usage-panel">
      <div className="scene-usage-header">
        <span className="scene-usage-title">Inspector</span>
      </div>
      <div className="so-inspector-subtitle">
        <span className="so-inspector-class">{schema.className}</span>
        {schema.menuPath && <span className="so-inspector-menu">{schema.menuPath}</span>}
      </div>

      <InspectorTabs
        tabs={[
          { id: 'instances', label: 'Instances', count: instances.length },
          { id: 'usages', label: 'Usages', count: usageCount },
          // Only when there is something to say. A permanent "Drift 0" tab
          // trains people to ignore it, which defeats the point.
          ...(drift.length > 0
            ? [{ id: 'drift', label: 'Drift', count: drift.length }]
            : []),
        ]}
        activeId={drift.length === 0 && activeTab === 'drift' ? 'instances' : activeTab}
        onSelect={(id) => setActiveTab(id as 'instances' | 'usages' | 'drift')}
      />

      {activeTab === 'drift' && drift.length > 0 ? (
        <SoDriftTab
          schema={schema}
          findings={drift}
          hashes={hashes}
          loading={driftLoading}
          onReload={reloadDrift}
        />
      ) : activeTab === 'usages' ? (
        // Instances have their own tab, so hide that section here rather than
        // showing every asset twice.
        //
        // The wrapper is load-bearing: `SceneUsagePanel` is itself a
        // `height: 100%` flex column, and nesting it directly inside another
        // one gives it no resolvable height. `flex: 1; min-height: 0` lets it
        // take the space the tabs leave and scroll inside it.
        <div className="so-inspector-nested">
          <SceneUsagePanel hideScriptableObjects />
        </div>
      ) : (
        // Instances is also the fallback: when the last drift finding is fixed
        // the Drift tab disappears, and the selection has to land somewhere.
        <SoInstancesTab
          schema={schema}
          instances={instances}
          isLoading={isLoading}
          unresolvedBase={schema.unresolvedBase}
        />
      )}
    </div>
  );
}

export default UnityInspectorPanel;
