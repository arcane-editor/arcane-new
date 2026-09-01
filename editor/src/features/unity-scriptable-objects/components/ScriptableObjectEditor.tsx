import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FileCode2, LoaderCircle, RotateCw } from 'lucide-react';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useUnityIndexStore } from '../../../stores/unity-index';
import { buildSoSchema, scanCSharp, type SoSchema } from '../../unity-analyzers';
import { noteSelfWrittenAsset, useSceneUsageStore } from '../../unity-context';
import {
  describeRejection,
  readAssetFields,
  writeAssetFields,
  type SoAssetSnapshot,
  type SoFieldEdit,
} from '../services/asset-fields-client';
import { buildRows, toEdit, toMemberEdit, type SoRow } from '../services/so-value-model';
import SoFieldRow from './SoFieldRow';

interface ScriptableObjectEditorProps {
  path: string;
  name: string;
  onViewRaw: () => void;
  onEditRaw: () => void;
  /** Rendered when this `.asset` is not a typed ScriptableObject instance. */
  fallback: React.ReactNode;
}

type Phase = 'probing' | 'typed' | 'fallback';

interface Probe {
  snapshot: SoAssetSnapshot;
  schema: SoSchema;
}

/**
 * The typed `.asset` editor: a Unity Inspector rendered from the C# class
 * instead of the raw YAML.
 *
 * Writes go through the Rust byte-exact writer, NOT through
 * `updateFileContent` + `saveFile`. That path would make TypeScript the source
 * of truth for byte layout and round-trip the file through a Monaco text model
 * that normalises line endings — defeating the entire point of the writer, on a
 * file format where a moved byte is a diff for the whole team.
 */
function ScriptableObjectEditor({
  path,
  name,
  onViewRaw,
  onEditRaw,
  fallback,
}: ScriptableObjectEditorProps) {
  const [phase, setPhase] = useState<Phase>('probing');
  const [probe, setProbe] = useState<Probe | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [staleOnDisk, setStaleOnDisk] = useState(false);
  const [busy, setBusy] = useState(false);
  const reloadToken = useRef(0);

  const isDirty = useWorkspaceStore(
    (s) => s.openFiles.find((f) => f.path === path)?.isDirty ?? false,
  );

  const load = useCallback(async () => {
    const token = ++reloadToken.current;
    try {
      const snapshot = await readAssetFields(path);
      if (token !== reloadToken.current) return;
      if (snapshot.classId !== '114' || !snapshot.scriptGuid) {
        setPhase('fallback');
        return;
      }
      const scriptPath = await useUnityIndexStore.getState().resolveGuid(snapshot.scriptGuid);
      if (token !== reloadToken.current) return;
      if (!scriptPath) {
        setPhase('fallback');
        return;
      }
      const abs = toAbsolute(scriptPath);
      const source = await invoke<string>('read_file', { path: abs });
      if (token !== reloadToken.current) return;

      const schema = buildSoSchema(scanCSharp(source));
      // A MonoBehaviour serialised into a .asset is a Unity-internal oddity,
      // not something this editor should claim.
      if (!schema || schema.baseKind === 'monoBehaviour') {
        setPhase('fallback');
        return;
      }
      setProbe({ snapshot, schema });
      setStaleOnDisk(false);
      setPhase('typed');
    } catch {
      if (token === reloadToken.current) setPhase('fallback');
    }
  }, [path]);

  useEffect(() => {
    setPhase('probing');
    setProbe(null);
    setErrors({});
    void load();
  }, [load]);

  const rows = useMemo(
    () => (probe ? buildRows(probe.schema, probe.snapshot) : []),
    [probe],
  );

  const commit = useCallback(
    async (row: SoRow, edit: SoFieldEdit | null) => {
      if (!probe || !edit) return;
      setBusy(true);
      try {
        // Tell the usage caches this write is ours, so the watcher event it
        // produces does not blank the Inspector panel.
        noteSelfWrittenAsset(path);
        const result = await writeAssetFields(path, [edit], probe.snapshot.sha1);
        if (result.rejections.length > 0) {
          setErrors((e) => ({ ...e, [row.yamlKey]: describeRejection(result.rejections[0]) }));
          return;
        }
        setErrors((e) => {
          const next = { ...e };
          delete next[row.yamlKey];
          return next;
        });
        await load();
        void useSceneUsageStore.getState().refreshActiveScript();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('changed on disk')) {
          setStaleOnDisk(true);
        } else {
          setErrors((e) => ({ ...e, [row.yamlKey]: message }));
        }
      } finally {
        setBusy(false);
      }
    },
    [probe, path, load],
  );

  if (phase === 'probing') {
    return (
      <Shell name={name} onViewRaw={onViewRaw} onEditRaw={onEditRaw} subtitle="Reading…">
        <div className="so-editor-empty">
          <LoaderCircle size={18} className="so-spin" strokeWidth={1.5} />
        </div>
      </Shell>
    );
  }

  if (phase === 'fallback' || !probe) return <>{fallback}</>;

  const { schema, snapshot } = probe;

  return (
    <Shell
      name={name}
      onViewRaw={onViewRaw}
      onEditRaw={onEditRaw}
      subtitle={schema.className}
    >
      {staleOnDisk && (
        <div className="so-editor-banner">
          <span>This asset changed on disk — reload to continue editing.</span>
          <button className="asset-viewer-btn" onClick={() => void load()}>
            <RotateCw size={12} /> Reload
          </button>
        </div>
      )}

      {isDirty && (
        <div className="so-editor-banner so-editor-banner-warn">
          You have unsaved raw edits to this file. Save or revert them before editing fields.
        </div>
      )}

      {schema.unresolvedBase && (
        <div className="so-editor-note">
          Inherited fields from <code>{schema.unresolvedBase}</code> are not shown.
        </div>
      )}

      <div className="so-editor-fields">
        {groupRows(rows, schema).map((group) => (
          <div key={group.header ?? '__none'} className="so-editor-group">
            {group.header && <div className="so-editor-group-header">{group.header}</div>}
            {group.rows.map((row) => (
              <SoFieldRow
                key={row.yamlKey}
                row={row}
                disabled={busy || isDirty || staleOnDisk}
                error={errors[row.yamlKey] ?? null}
                onCommit={(draft) => void commit(row, toEdit(row, draft, snapshot.documentFileId))}
                onCommitMember={(member, draft) =>
                  void commit(row, toMemberEdit(row, member, draft, snapshot.documentFileId))
                }
              />
            ))}
          </div>
        ))}
      </div>
    </Shell>
  );
}

/** Regroup bound rows under their schema `[Header]`s, keeping row order. */
function groupRows(rows: SoRow[], schema: SoSchema) {
  const headerFor = new Map<string, string | null>();
  for (const group of schema.groups) {
    for (const f of group.fields) headerFor.set(f.name, group.header);
  }
  const out: Array<{ header: string | null; rows: SoRow[] }> = [];
  for (const row of rows) {
    const header = row.field ? headerFor.get(row.field.name) ?? null : null;
    const last = out[out.length - 1];
    if (!last || last.header !== header) out.push({ header, rows: [row] });
    else last.rows.push(row);
  }
  return out;
}

/** Header chrome, identical to `AssetViewer`'s so switching does not flicker. */
function Shell({
  name,
  subtitle,
  onViewRaw,
  onEditRaw,
  children,
}: {
  name: string;
  subtitle: string;
  onViewRaw: () => void;
  onEditRaw: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="so-editor">
      <div className="so-editor-header">
        <FileCode2 size={14} style={{ opacity: 0.7 }} />
        <span className="so-editor-name">{name}</span>
        <span className="so-editor-subtitle">{subtitle}</span>
        <div className="so-editor-actions">
          <button className="asset-viewer-btn" onClick={onViewRaw}>
            View Raw
          </button>
          <button className="asset-viewer-btn" onClick={onEditRaw}>
            Edit Raw
          </button>
        </div>
      </div>
      {children}
    </div>
  );
}

/** Resolve a possibly workspace-relative index path to an absolute one. */
function toAbsolute(p: string): string {
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return p;
  const ws = useWorkspaceStore.getState().workspacePath;
  if (!ws) return p;
  return (ws.endsWith('/') ? ws : ws + '/') + p;
}

export default ScriptableObjectEditor;
