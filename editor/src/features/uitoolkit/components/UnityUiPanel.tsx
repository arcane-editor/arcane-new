import { useEffect, useState } from 'react';
import { PanelsTopLeft, AlertTriangle, RefreshCw, FileCode2, Palette } from 'lucide-react';
import { useWorkspaceStore } from '../../../stores/workspace';
import { loadUiToolkitSummary, type UiToolkitSummary } from '../services/uxml-assets';

/**
 * Sidebar view for UI Toolkit.
 *
 * It answers the question Unity's UI Builder cannot: across every `.uxml` and
 * `.uss` in the project, what is broken? A class no stylesheet declares renders
 * silently unstyled, and a property USS does not support is dropped at import
 * with no warning anywhere — neither shows up until someone notices the UI
 * looks wrong.
 */
export function UnityUiPanel() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const [summary, setSummary] = useState<UiToolkitSummary | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSummary(null);
    void loadUiToolkitSummary(workspacePath).then((next) => {
      if (!cancelled) setSummary(next);
    });
    return () => {
      cancelled = true;
    };
  }, [workspacePath, reloadToken]);

  const open = (path: string, name: string) => {
    void useWorkspaceStore.getState().openFile(path, name);
  };

  const empty =
    summary !== null && summary.documents.length === 0 && summary.stylesheets.length === 0;

  return (
    <div style={SHELL}>
      <div style={HEADER}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <PanelsTopLeft size={13} />
          Unity UI
        </span>
        {summary && summary.problemCount > 0 && (
          <span style={PROBLEM_CHIP}>
            <AlertTriangle size={10} /> {summary.problemCount}
          </span>
        )}
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

      {summary === null && <div style={NOTE}>Scanning the project.</div>}

      {empty && (
        <div style={NOTE}>
          No <code>.uxml</code> or <code>.uss</code> assets yet. Create one in Unity from
          <em> Assets &gt; Create &gt; UI Toolkit</em>, and it will show up here.
        </div>
      )}

      {summary && !empty && (
        <div style={{ overflowY: 'auto' }}>
          {summary.documents.length > 0 && <div style={GROUP}>Documents</div>}
          {summary.documents.map((doc) => (
            <button
              key={doc.path}
              type="button"
              style={ROW}
              onClick={() => open(doc.path, doc.name)}
              title={doc.path}
            >
              <FileCode2 size={12} style={{ color: 'var(--info)', flexShrink: 0 }} />
              <span style={NAME}>{doc.name}</span>
              <span style={META}>
                {doc.malformed
                  ? 'does not parse'
                  : `${doc.elementCount} named`}
              </span>
              {doc.undeclaredClasses.length > 0 && (
                <span
                  style={COUNT_BAD}
                  title={`No stylesheet declares: ${doc.undeclaredClasses.join(', ')}`}
                >
                  {doc.undeclaredClasses.length}
                </span>
              )}
            </button>
          ))}

          {summary.stylesheets.length > 0 && <div style={GROUP}>Stylesheets</div>}
          {summary.stylesheets.map((sheet) => (
            <button
              key={sheet.path}
              type="button"
              style={ROW}
              onClick={() => open(sheet.path, sheet.name)}
              title={sheet.path}
            >
              <Palette size={12} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              <span style={NAME}>{sheet.name}</span>
              <span style={META}>{sheet.ruleCount} rules</span>
              {sheet.invalidProperties.length > 0 && (
                <span
                  style={COUNT_BAD}
                  title={`Unity drops these at import: ${sheet.invalidProperties.join(', ')}`}
                >
                  {sheet.invalidProperties.length}
                </span>
              )}
            </button>
          ))}

          {summary.problemCount === 0 && (
            <div style={{ ...NOTE, paddingTop: 10 }}>
              Every class resolves and every property is valid USS.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const SHELL: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
};

const HEADER: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '0 10px',
  height: 32,
  flexShrink: 0,
  fontSize: 11,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--text-secondary)',
};

const GROUP: React.CSSProperties = {
  padding: '8px 10px 3px',
  fontSize: 10,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--text-dim, var(--text-secondary))',
};

const ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  width: '100%',
  padding: '4px 10px',
  border: 0,
  background: 'none',
  color: 'var(--text-primary)',
  fontFamily: 'inherit',
  fontSize: 12.5,
  cursor: 'pointer',
  textAlign: 'left',
};

const NAME: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const META: React.CSSProperties = {
  marginLeft: 'auto',
  color: 'var(--text-secondary)',
  fontSize: 11,
  whiteSpace: 'nowrap',
};

const PROBLEM_CHIP: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 10,
  letterSpacing: 0,
  padding: '1px 6px',
  borderRadius: 'var(--radius-full)',
  background: 'var(--error-bg)',
  border: '1px solid var(--error-border)',
  color: 'var(--error-text)',
};

const COUNT_BAD: React.CSSProperties = {
  fontSize: 10,
  fontFamily: 'var(--font-mono)',
  color: 'var(--error-text)',
  background: 'var(--error-bg)',
  border: '1px solid var(--error-border)',
  borderRadius: 'var(--radius-full)',
  padding: '0 5px',
  flexShrink: 0,
};

const NOTE: React.CSSProperties = {
  padding: '6px 12px',
  fontSize: 11.5,
  color: 'var(--text-secondary)',
  lineHeight: 1.5,
};

export default UnityUiPanel;
