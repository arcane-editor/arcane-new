import {
  byControl,
  coverageMatrix,
  explainStatus,
  type ActionNode,
  type ActionStatus,
  type InputGraph,
} from '../services/input-graph';
import { gotoActionReference } from '../services/goto-usage';
import type { ActionReference } from '../services/action-refs';

// The three pivots on one graph. They are separate components rather than one
// with a mode flag because they share only their styling: each answers a
// different question and their row shapes have nothing in common.

// ── Status vocabulary ────────────────────────────────────────────────────────

interface StatusLook {
  colour: string;
  glyph: string;
  /** Shown on the row. Deliberately a fact, not a scolding. */
  label: string;
}

const STATUS: Record<ActionStatus, StatusLook> = {
  wired: { colour: 'var(--success)', glyph: '✓', label: '' },
  unread: { colour: 'var(--error-text)', glyph: '✕', label: 'nothing reads this' },
  'never-fires': { colour: 'var(--warning)', glyph: '⚠', label: 'never fires' },
  'no-bindings': { colour: 'var(--error-text)', glyph: '✕', label: 'no bindings' },
  unknown: { colour: 'var(--info)', glyph: '◦', label: 'may be wired in the Inspector' },
};

/** The one line that says what happens when this action fires. */
function behaviourOf(node: ActionNode): ActionReference | null {
  return node.behaviours[0] ?? node.refs.find((r) => r.handler) ?? node.refs[0] ?? null;
}

function fileOf(ref: ActionReference): string {
  return `${ref.filePath.split('/').pop()}:${ref.line}`;
}

// ── By action ────────────────────────────────────────────────────────────────

export function ActionsView({ graph }: { graph: InputGraph }) {
  return (
    <div style={SCROLL}>
      {graph.maps.map((map) => (
        <section key={map.name} style={{ marginBottom: 18 }}>
          <h3 style={MAP_HEADING}>{map.name}</h3>
          {map.actions.map((node) => (
            <ActionRow key={node.qualifiedName} node={node} graph={graph} />
          ))}
        </section>
      ))}
    </div>
  );
}

function ActionRow({ node, graph }: { node: ActionNode; graph: InputGraph }) {
  const look = STATUS[node.status];
  const behaviour = behaviourOf(node);
  const controls = node.action.bindings.map((b) => b.label).filter(Boolean);

  return (
    <div style={{ ...ROW, borderLeftColor: look.colour }} title={explainStatus(node, graph.suppressors)}>
      <div style={ROW_HEAD}>
        <span style={{ color: look.colour, width: 12, flexShrink: 0 }}>{look.glyph}</span>
        <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{node.name}</span>
        <span style={META}>{node.action.type ?? 'Button'}</span>

        {/* The right-hand edge of the chain: what runs when this fires. This is
            the half Unity's own window cannot show, so it gets the space. */}
        <span style={ROW_TAIL}>
          {behaviour ? (
            <button type="button" style={LINK} onClick={() => void gotoActionReference(behaviour)}>
              <span style={{ color: 'var(--text-secondary)' }}>→</span>
              <span style={{ color: 'var(--accent)' }}>
                {behaviour.handler ? `${behaviour.handler}()` : behaviour.kind}
              </span>
              <span style={META}>{fileOf(behaviour)}</span>
            </button>
          ) : (
            <span style={{ ...META, color: look.colour }}>{look.label}</span>
          )}
        </span>
      </div>

      {/* Bindings are reference material, not the headline — quiet second line. */}
      {controls.length > 0 && (
        <div style={CONTROLS}>
          {controls.map((label) => (
            <span key={label} style={CHIP}>{label}</span>
          ))}
          {node.refs.length > 1 && (
            <span style={{ ...META, marginLeft: 'auto' }}>
              {node.refs.length} references
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── By control ───────────────────────────────────────────────────────────────

export function ControlsView({ graph }: { graph: InputGraph }) {
  const rows = byControl(graph);
  if (rows.length === 0) return <Empty>No controls are bound in this asset.</Empty>;

  return (
    <div style={SCROLL}>
      <p style={NOTE}>
        Every action a control triggers, across every map. Two actions on one
        control in the <em>same</em> map is a conflict; in different maps it is
        how a pause menu works.
      </p>
      {rows.map((row) => (
        <div key={row.path} style={{ ...ROW, borderLeftColor: 'var(--border)' }}>
          <div style={ROW_HEAD}>
            <span style={{ ...MONO, color: 'var(--text-primary)' }}>{row.path}</span>
            {row.device && <span style={META}>{row.device}</span>}
          </div>
          <div style={CONTROLS}>
            {row.actions.map((action) => (
              <span key={action.qualifiedName} style={CHIP} title={explainStatus(action, graph.suppressors)}>
                <span style={{ color: STATUS[action.status].colour, marginRight: 5 }}>
                  {STATUS[action.status].glyph}
                </span>
                {action.qualifiedName}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Coverage ─────────────────────────────────────────────────────────────────

export function CoverageView({ graph }: { graph: InputGraph }) {
  if (graph.schemes.length === 0) {
    return (
      <Empty>
        This asset declares no control schemes, so every binding is available to
        every device and there is nothing to cover.
      </Empty>
    );
  }
  const rows = coverageMatrix(graph);
  const holes = rows.filter((r) => r.hasHole).length;

  return (
    <div style={SCROLL}>
      <p style={NOTE}>
        {holes === 0
          ? 'Every action is reachable in every control scheme.'
          : `${holes} action${holes === 1 ? ' is' : 's are'} unreachable in at least one control scheme. This is the gap that surfaces during console certification rather than in the editor.`}
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table style={TABLE}>
          <thead>
            <tr>
              <th style={{ ...TH, textAlign: 'left' }}>Action</th>
              {graph.schemes.map((s) => (
                <th key={s} style={TH}>{s}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ action, cells, hasHole }) => (
              <tr key={action.qualifiedName}>
                <td style={{ ...TD, color: hasHole ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>{action.mapName}/</span>
                  {action.name}
                </td>
                {cells.map((cell) => (
                  <td key={cell.scheme} style={{ ...TD, textAlign: 'center' }}>
                    {cell.bound ? (
                      <span style={{ color: 'var(--success)' }}>●</span>
                    ) : (
                      <span style={{ color: 'var(--error-text)' }} title={`No binding for ${cell.scheme}`}>○</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Shared ───────────────────────────────────────────────────────────────────

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ ...NOTE, padding: 16 }}>{children}</div>;
}

const SCROLL: React.CSSProperties = { overflow: 'auto', flex: 1, padding: '10px 12px' };

const MAP_HEADING: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.09em',
  textTransform: 'uppercase',
  color: 'var(--text-secondary)',
  margin: '0 0 6px',
};

const ROW: React.CSSProperties = {
  borderLeft: '2px solid transparent',
  padding: '5px 0 6px 10px',
  marginBottom: 3,
};

const ROW_HEAD: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  fontSize: 12.5,
  minWidth: 0,
};

const ROW_TAIL: React.CSSProperties = {
  marginLeft: 'auto',
  display: 'flex',
  alignItems: 'baseline',
  gap: 6,
  minWidth: 0,
};

const META: React.CSSProperties = { color: 'var(--text-secondary)', fontSize: 11 };
const MONO: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 11.5 };

const NOTE: React.CSSProperties = {
  fontSize: 11.5,
  color: 'var(--text-secondary)',
  lineHeight: 1.5,
  margin: '0 0 12px',
  maxWidth: '72ch',
};

const CONTROLS: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
  paddingLeft: 20,
  marginTop: 3,
  alignItems: 'center',
};

const CHIP: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  padding: '1px 6px',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--surface-container-high)',
  border: '1px solid var(--border)',
  color: 'var(--text-secondary)',
};

const LINK: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 6,
  background: 'none',
  border: 0,
  padding: 0,
  cursor: 'pointer',
  fontSize: 12,
  fontFamily: 'inherit',
  minWidth: 0,
};

const TABLE: React.CSSProperties = {
  borderCollapse: 'collapse',
  fontSize: 12,
  minWidth: 'min(100%, 420px)',
};

const TH: React.CSSProperties = {
  padding: '4px 12px',
  fontSize: 10.5,
  fontWeight: 500,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-secondary)',
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
};

const TD: React.CSSProperties = {
  padding: '4px 12px',
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
};
