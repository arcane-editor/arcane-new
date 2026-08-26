import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronRight, ChevronDown, RefreshCw, Box, FileCode2, Unplug, Layers } from 'lucide-react';
import { useUnitySceneStore } from '../../../stores/unity-scene';
import { useUnityStore } from '../../../stores/unity';
import { useWorkspaceStore } from '../../../stores/workspace';
import { notify } from '../../../stores/notifications';
import { bridgeRpc, type HierarchyNode, type ProjectScene } from '../../unity-bridge';
import Tooltip from '../../../components/Tooltip';
import { hierarchyHasScriptIdentity, scriptsOf, type ScriptComponent } from '../services/hierarchy-scripts';

/** Open a project script by its exact asset path. */
function useOpenScript() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  return useCallback(
    (script: ScriptComponent['script']) => {
      if (!workspacePath) return;
      // `script.path` is project-relative (`Assets/Scripts/Player.cs`) and comes
      // from AssetDatabase, so it is exact. This replaces a fuzzy filename
      // search that guessed `<TypeName>.cs` — which could not distinguish a
      // package script from a project one, broke whenever a file name differed
      // from its class, and (because of a malformed invoke) never actually
      // opened anything at all.
      const abs = `${workspacePath}/${script.path}`;
      const name = script.path.split('/').pop() ?? script.path;
      void useWorkspaceStore.getState().openFile(abs, name);
    },
    [workspacePath],
  );
}

function ScriptRow({ script, type, depth }: { script: ScriptComponent['script']; type: string; depth: number }) {
  const open = useOpenScript();
  return (
    <button
      type="button"
      className="hierarchy-row hierarchy-row--script"
      style={{ paddingLeft: depth * 14 + 26 }}
      onClick={(e) => {
        e.stopPropagation();
        open(script);
      }}
      title={script.path}
    >
      <FileCode2 size={12} className="hierarchy-row-icon" />
      <span className="hierarchy-row-label">{type}</span>
    </button>
  );
}

interface NodeRowProps {
  node: HierarchyNode;
  depth: number;
  expanded: Set<number>;
  toggle: (id: number) => void;
}

function NodeRow({ node, depth, expanded, toggle }: NodeRowProps) {
  const scripts = scriptsOf(node);
  const hasDetail = node.children.length > 0 || scripts.length > 0;
  const isOpen = expanded.has(node.instanceId);

  return (
    <>
      <div
        className={`hierarchy-row${node.active ? '' : ' hierarchy-row--inactive'}`}
        style={{ paddingLeft: depth * 14 + 4 }}
        onClick={() => hasDetail && toggle(node.instanceId)}
        title={`${node.name}  [tag: ${node.tag}, layer: ${node.layer}]`}
      >
        {hasDetail ? (
          isOpen ? <ChevronDown size={12} className="hierarchy-row-chevron" />
                 : <ChevronRight size={12} className="hierarchy-row-chevron" />
        ) : (
          <span className="hierarchy-row-chevron" />
        )}
        <Box size={13} className="hierarchy-row-icon hierarchy-row-icon--object" />
        <span className="hierarchy-row-label">{node.name}</span>
        {/* Counts scripts, not components: a "12" that meant twelve built-ins
            told the user nothing they could act on. */}
        {scripts.length > 0 && <span className="hierarchy-row-count">{scripts.length}</span>}
      </div>
      {isOpen && (
        <>
          {scripts.map((c, i) => (
            <ScriptRow key={`s${i}`} script={c.script} type={c.type} depth={depth + 1} />
          ))}
          {node.children.map((ch) => (
            <NodeRow key={ch.instanceId} node={ch} depth={depth + 1} expanded={expanded} toggle={toggle} />
          ))}
        </>
      )}
    </>
  );
}

/** Scene picker across every scene in the project, not just the loaded ones. */
function ScenePicker({ scenes, onOpen }: { scenes: ProjectScene[]; onOpen: (s: ProjectScene) => void }) {
  if (scenes.length === 0) return null;
  return (
    <div className="hierarchy-scene-picker">
      <Layers size={12} className="hierarchy-scene-picker-icon" />
      <select
        className="hierarchy-scene-select"
        aria-label="Scene"
        value={scenes.find((s) => s.loaded)?.path ?? ''}
        onChange={(e) => {
          const next = scenes.find((s) => s.path === e.target.value);
          if (next && !next.loaded) onOpen(next);
        }}
      >
        {scenes.map((s) => (
          <option key={s.guid} value={s.path}>
            {s.name}
            {s.loaded ? ' — open' : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Live scene hierarchy mirroring the connected Unity Editor.
 *
 * Shows the project scripts on each GameObject — not its every component —
 * and opens them by their exact asset path. A scene picker lists every scene
 * in the project so switching no longer means alt-tabbing to Unity.
 */
export function HierarchyPanel() {
  const hierarchy = useUnitySceneStore((s) => s.hierarchy);
  const loading = useUnitySceneStore((s) => s.loading);
  const connected = useUnityStore((s) => s.connected);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [scenes, setScenes] = useState<ProjectScene[]>([]);

  useEffect(() => {
    const store = useUnitySceneStore.getState();
    void store.setupListeners();
    void store.refresh();
    return () => store.teardownListeners();
  }, []);

  // Scene list follows the connection and re-reads whenever the loaded scene
  // changes, so the picker's "— open" marker cannot go stale.
  useEffect(() => {
    if (!connected) {
      setScenes([]);
      return;
    }
    let cancelled = false;
    void bridgeRpc
      .listScenes()
      .then((r) => {
        if (!cancelled) setScenes(r.scenes ?? []);
      })
      .catch(() => {
        if (!cancelled) setScenes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [connected, hierarchy]);

  const toggle = useCallback((id: number) => {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);

  const handleOpenScene = useCallback(async (scene: ProjectScene) => {
    try {
      const res = await bridgeRpc.openScene(scene.path);
      if (!res.ok) {
        // A refusal is a decision Unity made (play mode, compiling, or the
        // user cancelling its save prompt) — report it as information, not
        // as a failure.
        notify.info(res.reason ?? 'Unity declined to change scene.');
        return;
      }
      void useUnitySceneStore.getState().refresh();
    } catch (err) {
      notify.error(`Could not open scene: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  // Decided across the whole hierarchy: an older Unity package sends no script
  // identity at all, which per-GameObject looks identical to "no scripts here".
  const packageIsOutdated = useMemo(
    () => hierarchy !== null && hierarchy.scenes.length > 0 && !hierarchyHasScriptIdentity(hierarchy),
    [hierarchy],
  );

  return (
    <div className="sidebar">
      <div className="explorer-header">
        <span className="explorer-header-title">Hierarchy</span>
        <div className="explorer-header-actions">
          <Tooltip label="Refresh Hierarchy" side="bottom">
            <button
              className="explorer-action-btn"
              onClick={() => void useUnitySceneStore.getState().refresh()}
            >
              <RefreshCw size={14} className={loading ? 'spin' : ''} />
            </button>
          </Tooltip>
        </div>
      </div>

      {connected && <ScenePicker scenes={scenes} onOpen={handleOpenScene} />}

      <div className="sidebar-tree" style={{ overflow: 'auto' }}>
        {!connected ? (
          <div className="hierarchy-empty">
            <Unplug size={20} />
            <div>Unity Editor not connected.</div>
            <div className="hierarchy-empty-hint">
              Open this project in Unity with the bridge installed to mirror its live hierarchy here.
            </div>
          </div>
        ) : !hierarchy ? (
          <div className="hierarchy-note">Loading…</div>
        ) : hierarchy.scenes.length === 0 ? (
          <div className="hierarchy-note">No open scenes.</div>
        ) : (
          <>
            {packageIsOutdated && (
              <div className="hierarchy-note hierarchy-note--warning">
                Update the UnityIDE Unity package to see scripts here — the installed
                version does not report which components are project scripts.
              </div>
            )}
            {hierarchy.scenes.map((scene) => (
              <div key={scene.path || scene.name}>
                <div className="hierarchy-scene-label">{scene.name}</div>
                {scene.roots.map((r) => (
                  <NodeRow key={r.instanceId} node={r} depth={0} expanded={expanded} toggle={toggle} />
                ))}
              </div>
            ))}
            {hierarchy.truncated && (
              <div className="hierarchy-note hierarchy-note--warning">
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
