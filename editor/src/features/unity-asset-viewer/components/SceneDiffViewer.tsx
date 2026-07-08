import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChevronRight, ChevronDown, GitCompare, Code2, FilePlus, FileMinus, Move, Pencil } from 'lucide-react';
import { useWorkspaceStore } from '../../../stores/workspace';
import { GuidRef } from './AssetViewer';
import { extractGuid } from '../services/asset-model';
import { formatDiffSummaryLine, humanizeInlineMap, groupPrefabOverrides } from '../services/scene-diff-model';
import type {
  SceneDiff,
  ObjectDiff,
  ObjectDiffStatus,
  ComponentDiff,
  PropertyDiff,
  PrefabOverrideDiff,
  PrefabOverrideGroup,
} from '../services/scene-diff-model';

interface Props {
  /** Workspace-relative path, e.g. "Assets/Scenes/Main.unity" — matches `DiffInfo.filePath`. */
  filePath: string;
  /** Tab title, shown in the header (matches `AssetViewer`'s `name` prop). */
  name: string;
  staged: boolean;
  onViewText: () => void;
  /** Called once, when the command errors or the parsed diff is empty (nothing to show). */
  onFallback: () => void;
}

const STATUS_COLOR: Record<ObjectDiffStatus, string> = {
  added: 'var(--git-added)',
  removed: 'var(--git-deleted)',
  modified: 'var(--git-modified)',
  renamed: 'var(--accent, #4ec9b0)',
  moved: 'var(--info)',
};

const STATUS_ICON: Record<ObjectDiffStatus, typeof FilePlus> = {
  added: FilePlus,
  removed: FileMinus,
  modified: Pencil,
  renamed: Pencil,
  moved: Move,
};

const STATUS_VERB: Record<ObjectDiffStatus, string> = {
  added: 'Added',
  removed: 'Removed',
  modified: 'Modified',
  renamed: 'Renamed',
  moved: 'Moved',
};

/** Object label for the row's title, distinct per status (mirrors scene-diff-model's text formatter). */
function objectLabel(od: ObjectDiff): string {
  if (od.status === 'renamed') return `'${od.oldName}' → '${od.newName}'`;
  return `'${od.name}'`;
}

/** A property value: guid values render as a clickable `GuidRef`, `null` renders as ∅. */
function DiffValue({ value }: { value: string | null }) {
  if (value === null) {
    return (
      <span style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}>
        ∅
      </span>
    );
  }
  const guid = extractGuid(value);
  if (guid) return <GuidRef guid={guid} />;
  const humanized = humanizeInlineMap(value);
  const v = humanized.length > 200 ? humanized.slice(0, 200) + '…' : humanized;
  return <span style={{ color: 'var(--text-primary)' }}>{v}</span>;
}

function PropertyDiffRow({ p }: { p: PropertyDiff }) {
  return (
    <div
      style={{
        paddingLeft: 30,
        fontSize: 12.5,
        color: 'var(--text-secondary)',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        height: 22,
      }}
    >
      <span>{p.key}:</span>
      <DiffValue value={p.old} />
      <span>→</span>
      <DiffValue value={p.new} />
    </div>
  );
}

function ComponentDiffRow({ c }: { c: ComponentDiff }) {
  if (c.status !== 'modified') {
    const color = c.status === 'added' ? 'var(--git-added)' : 'var(--git-deleted)';
    return (
      <div
        style={{
          paddingLeft: 30,
          fontSize: 12.5,
          color: 'var(--text-secondary)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          height: 22,
        }}
      >
        <span style={{ color }}>{c.status === 'added' ? '+' : '−'}</span>
        {c.scriptGuid ? <GuidRef guid={c.scriptGuid} label={c.typeName} /> : <span>{c.typeName}</span>}
      </div>
    );
  }
  return (
    <>
      <div
        style={{
          paddingLeft: 30,
          fontSize: 12.5,
          fontWeight: 600,
          color: 'var(--text-secondary)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          height: 22,
        }}
      >
        {c.scriptGuid ? <GuidRef guid={c.scriptGuid} label={c.typeName} /> : <span>{c.typeName}</span>}
      </div>
      {c.propertyDiffs.map((p, i) => (
        <div key={i} style={{ paddingLeft: 14 }}>
          <PropertyDiffRow p={p} />
        </div>
      ))}
    </>
  );
}

function ObjectDiffRow({
  od,
  expanded,
  toggle,
}: {
  od: ObjectDiff;
  expanded: Set<string>;
  toggle: (id: string) => void;
}) {
  const hasDetail = od.propertyDiffs.length > 0 || od.componentDiffs.length > 0;
  const isOpen = expanded.has(od.fileId);
  const color = STATUS_COLOR[od.status];
  const Icon = STATUS_ICON[od.status];

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '2px 10px',
          height: 24,
          fontSize: 13,
          cursor: hasDetail ? 'pointer' : 'default',
        }}
        onClick={() => hasDetail && toggle(od.fileId)}
        title={od.hierarchyPath}
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
        <Icon size={13} style={{ color, flexShrink: 0 }} />
        <span style={{ color, flexShrink: 0 }}>{STATUS_VERB[od.status]}</span>
        <span style={{ color: 'var(--text-primary)' }}>{objectLabel(od)}</span>
        {(od.oldParentName !== null || od.newParentName !== null) && (
          // Populated whenever the parent changed, independent of `status`
          // (renamed status wins over "moved" per the Rust engine, but a
          // rename+reparent still carries both facts — see unity_diff.rs).
          <span style={{ color: 'var(--text-secondary)', fontSize: 11.5 }}>
            moved from '{od.oldParentName ?? '?'}' to '{od.newParentName ?? '?'}'
          </span>
        )}
        {od.subtreeSummary && (
          <span style={{ color: 'var(--text-secondary)', fontSize: 11.5 }}>
            ({od.subtreeSummary.componentTypes.length} component{od.subtreeSummary.componentTypes.length === 1 ? '' : 's'}
            , {od.subtreeSummary.childCount} {od.subtreeSummary.childCount === 1 ? 'child' : 'children'})
          </span>
        )}
      </div>
      {isOpen && (
        <>
          {od.propertyDiffs.map((p, i) => (
            <PropertyDiffRow key={`p${i}`} p={p} />
          ))}
          {od.componentDiffs.map((c, i) => (
            <ComponentDiffRow key={`c${i}`} c={c} />
          ))}
        </>
      )}
    </>
  );
}

/** One override row beneath its group's header — just `propertyPath: old → new` (the owning prefab is the header). */
function PrefabOverrideRow({ p }: { p: PrefabOverrideDiff }) {
  const isReferenceChange = p.oldObjectReference !== null || p.newObjectReference !== null;
  const color = p.status === 'added' ? 'var(--git-added)' : p.status === 'removed' ? 'var(--git-deleted)' : 'var(--git-modified)';
  const sign = p.status === 'added' ? '+' : p.status === 'removed' ? '−' : '~';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 10px',
        paddingLeft: 40,
        fontSize: 12.5,
        color: 'var(--text-secondary)',
        minHeight: 22,
        flexWrap: 'wrap',
      }}
    >
      <span style={{ color }}>{sign}</span>
      <span>{p.propertyPath}:</span>
      {isReferenceChange ? (
        p.status === 'removed' ? (
          <span>reference removed</span>
        ) : p.objectReferenceGuid ? (
          <GuidRef guid={p.objectReferenceGuid} label={p.objectReferenceAssetName ?? undefined} />
        ) : (
          <span>{p.objectReferenceAssetName ?? 'reference changed'}</span>
        )
      ) : (
        <>
          <DiffValue value={p.oldValue} />
          <span>→</span>
          <DiffValue value={p.newValue} />
        </>
      )}
    </div>
  );
}

/** Section for one source prefab's overrides: a header naming the instance, then its rows. */
function PrefabOverrideGroupSection({ group }: { group: PrefabOverrideGroup }) {
  return (
    <div>
      <div
        style={{
          padding: '2px 10px',
          paddingLeft: 26,
          fontSize: 12.5,
          fontWeight: 600,
          color: 'var(--text-secondary)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span>Overrides on</span>
        {group.prefabAssetName ? (
          group.prefabAssetGuid ? (
            <GuidRef guid={group.prefabAssetGuid} label={`${group.prefabAssetName}.prefab`} />
          ) : (
            <span>{`'${group.prefabAssetName}.prefab'`}</span>
          )
        ) : (
          <span>{`prefab instance ${group.prefabInstanceFileId}`}</span>
        )}
        <span>instance</span>
        <span style={{ fontSize: 11.5 }}>{`(fileID: ${group.prefabInstanceFileId})`}</span>
      </div>
      {group.rows.map((p, i) => (
        <PrefabOverrideRow key={i} p={p} />
      ))}
    </div>
  );
}

/**
 * Semantic (GameObject/component/property-level) diff viewer for Unity scene
 * / prefab / asset files, driven by the Rust `unity_scene_diff` diff engine
 * (P6.1). Rendering follows `AssetViewer`'s tree look — a thin header with a
 * toggle back to the raw text diff, then a scrollable tree of color-coded
 * object rows.
 *
 * On command failure OR an empty parse (no object diffs and no prefab
 * override diffs — e.g. a plain `.asset`/`.mat` ScriptableObject with no
 * GameObjects, which this engine can't represent structurally), renders
 * nothing and calls `onFallback` once so the caller (`EditorPanel`) can swap
 * to the existing Monaco text diff automatically.
 */
export function SceneDiffViewer({ filePath, name, staged, onViewText, onFallback }: Props) {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const [diff, setDiff] = useState<SceneDiff | null>(null);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setFailed(false);
    setExpanded(new Set());

    if (!workspacePath) {
      setFailed(true);
      return;
    }

    void invoke<SceneDiff>('unity_scene_diff', { workspacePath, filePath, staged })
      .then((d) => {
        if (cancelled) return;
        if (d.objectDiffs.length === 0 && d.prefabOverrideDiffs.length === 0) {
          setFailed(true);
        } else {
          setDiff(d);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          console.error('[scene-diff] failed to compute scene diff', e);
          setFailed(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [workspacePath, filePath, staged]);

  useEffect(() => {
    if (failed) onFallback();
    // `onFallback` intentionally excluded: it flips the caller's per-tab
    // view-mode state, which must not re-trigger this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failed]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  if (failed) return null;

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
        <GitCompare size={14} />
        <span style={{ color: 'var(--text-primary)' }}>{name}</span>
        <span style={{ opacity: 0.7 }}>semantic diff</span>
        {diff && <span style={{ opacity: 0.7 }}>· {formatDiffSummaryLine(diff)}</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button className="asset-viewer-btn" onClick={onViewText} title="Show the raw YAML text diff">
            <Code2 size={13} /> View Text Diff
          </button>
        </div>
      </div>
      <div style={{ overflow: 'auto', flex: 1, padding: '6px 0' }}>
        {!diff ? (
          <div style={{ padding: 16, color: 'var(--text-secondary)', fontSize: 13 }}>Computing diff…</div>
        ) : (
          <>
            {diff.objectDiffs.map((od) => (
              <ObjectDiffRow key={od.fileId} od={od} expanded={expanded} toggle={toggle} />
            ))}
            {diff.truncated && (
              <div style={{ padding: '6px 10px', fontSize: 12, color: 'var(--warning, #d7ba7d)' }}>
                Showing the first 500 changed objects — the exact counts above cover every change.
              </div>
            )}
            {diff.prefabOverrideDiffs.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div
                  style={{
                    padding: '4px 10px',
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--text-secondary)',
                  }}
                >
                  Prefab overrides
                </div>
                {groupPrefabOverrides(diff.prefabOverrideDiffs).map((group) => (
                  <PrefabOverrideGroupSection key={group.key} group={group} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default SceneDiffViewer;
