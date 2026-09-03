import { useCallback, useState } from 'react';
import { AlertTriangle, ArrowRight, LoaderCircle, PlusCircle, Trash2, Check } from 'lucide-react';
import { useWorkspaceStore } from '../../../stores/workspace';
import { noteSelfWrittenAsset, useSceneUsageStore } from '../../unity-context';
import type { SoSchema } from '../../unity-analyzers';
import { describeRejection, writeAssetFields } from '../services/asset-fields-client';
import {
  describeDrift,
  fixEditsFor,
  type DriftFinding,
} from '../services/so-drift';

interface SoDriftTabProps {
  schema: SoSchema;
  findings: DriftFinding[];
  /** sha1 of each asset at read time, for the concurrency guard. */
  hashes: Map<string, string>;
  loading: boolean;
  onReload: () => void;
}

const KIND_LABEL: Record<DriftFinding['kind'], string> = {
  renamed: 'Renamed',
  added: 'Added in code',
  orphan: 'Orphan key',
};

/**
 * What the class says vs. what the assets store.
 *
 * The rename case leads because it is the only one that destroys data: Unity
 * cannot match a renamed field to its old key, so every tuned value silently
 * reverts to the default — with no compiler error and no warning.
 */
function SoDriftTab({ schema, findings, hashes, loading, onReload }: SoDriftTabProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Set<string>>(new Set());

  const applyFix = useCallback(
    async (finding: DriftFinding) => {
      const id = `${finding.kind}:${finding.key}`;
      const field = schema.fields.find((f) => f.name === finding.key) ?? null;
      const byPath = fixEditsFor(finding, field);
      if (byPath.size === 0) return;

      setBusy(id);
      setErrors((e) => {
        const next = { ...e };
        delete next[id];
        return next;
      });
      try {
        const failures: string[] = [];
        for (const [path, edits] of byPath) {
          const sha1 = hashes.get(path);
          if (!sha1) {
            failures.push(`${path}: not read`);
            continue;
          }
          noteSelfWrittenAsset(path);
          // Each asset is its own atomic write; a failure on one leaves the
          // others already repaired rather than rolling everything back, which
          // is what you want when one file is checked out read-only.
          const result = await writeAssetFields(path, edits, sha1);
          if (result.rejections.length > 0) {
            failures.push(`${path.split('/').pop()}: ${describeRejection(result.rejections[0])}`);
          }
        }
        if (failures.length > 0) {
          setErrors((e) => ({ ...e, [id]: failures.join(' · ') }));
        } else {
          setDone((d) => new Set(d).add(id));
          void useSceneUsageStore.getState().refreshActiveScript();
          onReload();
        }
      } catch (err) {
        setErrors((e) => ({
          ...e,
          [id]: err instanceof Error ? err.message : String(err),
        }));
      } finally {
        setBusy(null);
      }
    },
    [schema, hashes, onReload],
  );

  if (loading) {
    return (
      <div className="so-instances-empty">
        <LoaderCircle size={20} className="so-spin" strokeWidth={1.5} />
        <span>Comparing the class with its assets…</span>
      </div>
    );
  }

  if (findings.length === 0) {
    return (
      <div className="so-instances-empty">
        <Check size={26} strokeWidth={1.25} style={{ opacity: 0.5 }} />
        <div className="so-instances-empty-title">No drift</div>
        <div className="so-instances-empty-hint">
          Every asset stores exactly the fields <code>{schema.className}</code> declares.
        </div>
      </div>
    );
  }

  return (
    <div className="so-drift">
      {findings.map((f) => {
        const id = `${f.kind}:${f.key}`;
        const isDone = done.has(id);
        return (
          <div key={id} className={`so-drift-card so-drift-${f.kind}`}>
            <div className="so-drift-head">
              <span className={`so-drift-badge so-drift-badge-${f.kind}`}>{KIND_LABEL[f.kind]}</span>
              <span className="so-drift-sig">
                {f.kind === 'renamed' ? (
                  <>
                    <s>{f.formerKey}</s>
                    <ArrowRight size={11} />
                    {f.key}
                  </>
                ) : (
                  f.key
                )}
              </span>
              <span className="so-drift-count">
                {f.assets.length} {f.assets.length === 1 ? 'asset' : 'assets'}
              </span>
            </div>

            <p className="so-drift-why">{describeDrift(f)}</p>

            <div className="so-drift-assets" title={f.assets.map((a) => a.path).join('\n')}>
              {f.assets.slice(0, 4).map((a) => a.name).join(', ')}
              {f.assets.length > 4 && ` +${f.assets.length - 4} more`}
            </div>

            {errors[id] && <div className="so-field-error">{errors[id]}</div>}

            <div className="so-drift-actions">
              {isDone ? (
                <span className="so-drift-done">
                  <Check size={12} /> Fixed
                </span>
              ) : f.fixable ? (
                <button
                  className="asset-viewer-btn"
                  disabled={busy !== null}
                  onClick={() => void applyFix(f)}
                >
                  {busy === id ? (
                    <LoaderCircle size={12} className="so-spin" />
                  ) : f.kind === 'orphan' ? (
                    <Trash2 size={12} />
                  ) : (
                    <PlusCircle size={12} />
                  )}
                  {f.kind === 'renamed'
                    ? `Move the value in ${f.assets.length}`
                    : f.kind === 'added'
                      ? `Write the default to ${f.assets.length}`
                      : `Strip from ${f.assets.length}`}
                </button>
              ) : (
                <span className="so-drift-note">
                  <AlertTriangle size={11} /> No safe default for this type — set it per asset.
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Open one of the affected assets, for a caller that wants a jump target. */
export function openDriftAsset(path: string): void {
  const name = path.split('/').pop() ?? path;
  void useWorkspaceStore.getState().openFile(path, name);
}

export default SoDriftTab;
