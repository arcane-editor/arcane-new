import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useUnityIndexStore, type RefHit } from '../../../stores/unity-index';
import { readMetaGuid } from '../services/meta-file-manager';

interface Props {
  /** Absolute path of the asset/script about to be deleted. */
  path: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function classify(refs: RefHit[]): { scenes: number; prefabs: number; other: number } {
  let scenes = 0,
    prefabs = 0,
    other = 0;
  for (const r of refs) {
    const l = r.path.toLowerCase();
    if (l.endsWith('.unity')) scenes++;
    else if (l.endsWith('.prefab')) prefabs++;
    else other++;
  }
  return { scenes, prefabs, other };
}

function summarize(refs: RefHit[]): string {
  const { scenes, prefabs, other } = classify(refs);
  const parts: string[] = [];
  if (scenes) parts.push(`${scenes} scene${scenes === 1 ? '' : 's'}`);
  if (prefabs) parts.push(`${prefabs} prefab${prefabs === 1 ? '' : 's'}`);
  if (other) parts.push(`${other} other asset${other === 1 ? '' : 's'}`);
  return parts.join(', ');
}

/**
 * Safe-delete impact preview (F-6.3). Before deleting a Unity asset/script,
 * resolve its GUID and show which scenes/prefabs/assets reference it (offline
 * index) so the user understands the blast radius — deleting will leave Missing
 * Script / missing-reference entries in those assets.
 */
export function ImpactDeleteDialog({ path, onConfirm, onCancel }: Props) {
  const [refs, setRefs] = useState<RefHit[] | null>(null);
  const name = path.split('/').pop() || path;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const guid = await readMetaGuid(path);
      if (!guid) {
        if (!cancelled) setRefs([]);
        return;
      }
      const hits = await useUnityIndexStore.getState().findReferences(guid);
      if (!cancelled) setRefs(hits);
    })();
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const hasImpact = refs != null && refs.length > 0;

  return (
    <div className="app-modal-root" onMouseDown={onCancel}>
      <div
        className="app-modal-card"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        style={{ minWidth: 420 }}
      >
        <div className="app-modal-icon">
          <AlertTriangle size={26} style={{ color: hasImpact ? 'var(--warning)' : 'var(--text-secondary)' }} />
        </div>
        <div className="app-modal-title">Delete "{name}"?</div>
        <div className="app-modal-body">
          {refs == null ? (
            'Checking references…'
          ) : hasImpact ? (
            <>
              <strong>{name}</strong> is referenced by <strong>{summarize(refs)}</strong>. Deleting it
              will leave Missing Script / missing-reference entries in those assets.
            </>
          ) : (
            'No known scene/prefab references to this asset (per the offline index).'
          )}
        </div>
        {hasImpact && refs && (
          <div
            style={{
              maxHeight: 160,
              overflow: 'auto',
              margin: '8px 0',
              border: '1px solid var(--border)',
              borderRadius: 4,
              fontSize: 12,
            }}
          >
            {refs.slice(0, 100).map((r) => (
              <div
                key={r.path}
                style={{
                  padding: '3px 8px',
                  display: 'flex',
                  gap: 8,
                  borderBottom: '1px solid var(--border)',
                }}
                title={r.path}
              >
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.path}
                </span>
                <span style={{ color: 'var(--text-secondary)' }}>{r.count}×</span>
              </div>
            ))}
          </div>
        )}
        <div className="app-modal-actions">
          <button className="app-modal-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="app-modal-primary"
            onClick={onConfirm}
            disabled={refs == null}
            style={{ opacity: refs == null ? 0.5 : 1 }}
          >
            Delete{hasImpact ? ' anyway' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ImpactDeleteDialog;
