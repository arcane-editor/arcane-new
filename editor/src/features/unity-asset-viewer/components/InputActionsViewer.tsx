import { useMemo } from 'react';
import { Gamepad2, Code2, Pencil } from 'lucide-react';

interface Props {
  name: string;
  /** Raw .inputactions JSON content. */
  content: string;
  onViewRaw: () => void;
  onEditRaw: () => void;
}

interface IaAction {
  name?: string;
  type?: string;
  expectedControlType?: string;
}
interface IaBinding {
  name?: string;
  path?: string;
  action?: string;
  isComposite?: boolean;
  isPartOfComposite?: boolean;
}
interface IaMap {
  name?: string;
  actions?: IaAction[];
  bindings?: IaBinding[];
}
interface IaAsset {
  name?: string;
  maps?: IaMap[];
  controlSchemes?: { name?: string }[];
}

export function isInputActionsFile(name: string): boolean {
  return name.toLowerCase().endsWith('.inputactions');
}

/**
 * Structured viewer for Unity Input System `.inputactions` assets (JSON, F-3.2
 * P2). Renders each action map → actions (with control type) and their bindings,
 * plus the control schemes. Raw/Edit toggle out to Monaco.
 */
export function InputActionsViewer({ name, content, onViewRaw, onEditRaw }: Props) {
  const parsed = useMemo<{ asset: IaAsset | null; error: string | null }>(() => {
    try {
      return { asset: JSON.parse(content) as IaAsset, error: null };
    } catch (e) {
      return { asset: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [content]);

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
        <Gamepad2 size={14} />
        <span style={{ color: 'var(--text-primary)' }}>{name}</span>
        <span style={{ opacity: 0.7 }}>input actions</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button className="asset-viewer-btn" onClick={onViewRaw}>
            <Code2 size={13} /> View Raw
          </button>
          <button className="asset-viewer-btn" onClick={onEditRaw}>
            <Pencil size={13} /> Edit Raw
          </button>
        </div>
      </div>
      <div style={{ overflow: 'auto', flex: 1, padding: '6px 10px' }}>
        {parsed.error ? (
          <div style={{ color: 'var(--error-text)', fontSize: 13 }}>
            Could not parse .inputactions JSON: {parsed.error}
            <div style={{ marginTop: 8 }}>
              <button className="asset-viewer-btn" onClick={onViewRaw}>
                View Raw
              </button>
            </div>
          </div>
        ) : (
          <>
            {(parsed.asset?.maps ?? []).map((map, mi) => (
              <div key={mi} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{map.name}</div>
                {(map.actions ?? []).map((a, ai) => {
                  const bindings = (map.bindings ?? []).filter(
                    (b) => b.action === a.name && !b.isComposite,
                  );
                  return (
                    <div key={ai} style={{ paddingLeft: 12, marginBottom: 4 }}>
                      <div style={{ fontSize: 12.5 }}>
                        <span style={{ color: 'var(--accent, #4ec9b0)' }}>{a.name}</span>
                        <span style={{ color: 'var(--text-secondary)', marginLeft: 6, fontSize: 11 }}>
                          {a.type}
                          {a.expectedControlType ? ` · ${a.expectedControlType}` : ''}
                        </span>
                      </div>
                      {bindings.map((b, bi) => (
                        <div
                          key={bi}
                          style={{ paddingLeft: 14, fontSize: 11, color: 'var(--text-secondary)' }}
                        >
                          {b.path || b.name || '(binding)'}
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            ))}
            {(parsed.asset?.controlSchemes?.length ?? 0) > 0 && (
              <div style={{ marginTop: 8, fontSize: 12 }}>
                <span style={{ color: 'var(--text-secondary)' }}>Control schemes: </span>
                {parsed.asset!.controlSchemes!.map((c) => c.name).filter(Boolean).join(', ')}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default InputActionsViewer;
