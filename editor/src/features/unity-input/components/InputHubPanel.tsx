import { useEffect, useState } from 'react';
import { Gamepad2, AlertTriangle, RefreshCw } from 'lucide-react';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useProjectContextStore } from '../../../stores/project-context';
import { listInputActionAssets, type InputAssetSummary } from '../services/input-assets';

/**
 * Sidebar view for the Input Hub.
 *
 * Only ever mounted when the project actually runs the New Input System --
 * `ActivityBar` gates the icon on `isNewInputSystemActive`, so a project on the
 * legacy Input Manager never reaches this component at all.
 *
 * It answers one question the Unity Editor cannot: across every
 * `.inputactions` asset in the project, which actions are broken? Binding
 * conflicts are surfaced here because Unity reports nothing at all for them --
 * the losing action just silently never fires.
 */
export function InputHubPanel() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const inputSystem = useProjectContextStore((s) => s.inputSystem);
  const [assets, setAssets] = useState<InputAssetSummary[] | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!workspacePath) {
      setAssets([]);
      return;
    }
    let cancelled = false;
    setAssets(null);
    listInputActionAssets(workspacePath)
      .then((found) => {
        if (!cancelled) setAssets(found);
      })
      .catch(() => {
        if (!cancelled) setAssets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspacePath, reloadToken]);

  const openAsset = (asset: InputAssetSummary) => {
    void useWorkspaceStore.getState().openFile(asset.path, asset.name);
  };

  const totalConflicts = (assets ?? []).reduce((n, a) => n + a.conflicts.length, 0);

  return (
    <div style={SHELL}>
      <div style={HEADER}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Gamepad2 size={13} />
          Input actions
        </span>
        <button
          type="button"
          className="asset-viewer-btn"
          title="Rescan the project"
          onClick={() => setReloadToken((n) => n + 1)}
          style={{ marginLeft: 'auto' }}
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {inputSystem === 'Both' && (
        <div style={NOTE}>
          This project has both input systems enabled. Legacy <code>Input.GetAxis</code> calls
          still work here, so a mix of both is expected rather than a mistake.
        </div>
      )}

      {assets === null && <div style={NOTE}>Scanning the project.</div>}

      {assets !== null && assets.length === 0 && (
        <div style={NOTE}>
          No <code>.inputactions</code> assets yet. Create one in Unity from
          <em> Assets &gt; Create &gt; Input Actions</em>, and it will show up here.
        </div>
      )}

      {assets !== null && assets.length > 0 && (
        <>
          {totalConflicts > 0 && (
            <div style={CONFLICT_BANNER}>
              <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>
                {totalConflicts} binding conflict{totalConflicts === 1 ? '' : 's'}. Two actions in
                one map share a control, so the second one never fires.
              </span>
            </div>
          )}

          <div style={{ overflowY: 'auto', flex: 1 }}>
            {assets.map((asset) => (
              <button key={asset.path} type="button" onClick={() => openAsset(asset)} style={ROW}>
                <span style={{ color: 'var(--text-primary)', fontSize: 12.5 }}>{asset.name}</span>
                <span style={META}>
                  {asset.error
                    ? 'unreadable'
                    : `${asset.mapCount} maps, ${asset.actionCount} actions`}
                </span>
                {asset.conflicts.length > 0 && (
                  <span style={CONFLICT_CHIP} title={asset.conflicts.map((c) => c.path).join('\n')}>
                    {asset.conflicts.length}
                  </span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const SHELL: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  overflow: 'hidden',
};

const HEADER: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 10px',
  borderBottom: '1px solid var(--border)',
  fontSize: 11,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--text-secondary)',
  flexShrink: 0,
};

const NOTE: React.CSSProperties = {
  padding: '10px 12px',
  fontSize: 11.5,
  lineHeight: 1.5,
  color: 'var(--text-secondary)',
};

const CONFLICT_BANNER: React.CSSProperties = {
  display: 'flex',
  gap: 6,
  margin: '8px 10px',
  padding: '7px 9px',
  borderRadius: 'var(--radius-md)',
  background: 'var(--error-bg)',
  border: '1px solid var(--error-border)',
  color: 'var(--error-text)',
  fontSize: 11.5,
  lineHeight: 1.45,
};

const ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '5px 12px',
  background: 'none',
  border: 0,
  cursor: 'pointer',
  textAlign: 'left',
};

const META: React.CSSProperties = {
  color: 'var(--text-secondary)',
  fontSize: 11,
  marginLeft: 'auto',
  whiteSpace: 'nowrap',
};

const CONFLICT_CHIP: React.CSSProperties = {
  fontSize: 10,
  minWidth: 15,
  textAlign: 'center',
  padding: '0 4px',
  borderRadius: 'var(--radius-full)',
  background: 'var(--error-bg)',
  border: '1px solid var(--error-border)',
  color: 'var(--error-text)',
};

export default InputHubPanel;
