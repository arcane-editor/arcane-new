import { useEffect, useState } from 'react';
import { AlertTriangle, Check, CornerDownRight, Layers, List, Link2Off } from 'lucide-react';
import { GuidRef } from '../../unity-asset-viewer';
import type { SoRow } from '../services/so-value-model';
import { enumLabel, nicifyFieldName, summarizeRaw, toDisplay } from '../services/so-value-format';

interface SoFieldRowProps {
  row: SoRow;
  /** Disabled while the tab has unsaved raw edits, or a write is in flight. */
  disabled: boolean;
  error: string | null;
  onCommit: (draft: string) => void;
  onCommitMember: (member: string, draft: string) => void;
}

const GUID_RE = /guid:\s*([0-9a-fA-F]{32})/;
const FILE_ID_ZERO = /^\{fileID:\s*0\}$/;

/** One label + control row of the typed inspector. */
function SoFieldRow({ row, disabled, error, onCommit, onCommitMember }: SoFieldRowProps) {
  // Unity's own label spelling — people navigate by "Loaded Layout", not by the
  // C# identifier. The identifier stays in the tooltip for anyone reading code.
  const label = nicifyFieldName(row.field?.name ?? row.yamlKey);
  const tip = [row.field?.tooltip, row.field?.csharpType, row.yamlKey]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className={`so-field-row${error ? ' so-field-row-error' : ''}`}>
      <div className="so-field-label" title={tip}>
        <span className="so-field-name">{label}</span>
        <Chips row={row} />
      </div>

      <div className="so-field-control">
        <Control
          row={row}
          label={label}
          raw={row.value?.raw ?? ''}
          disabled={disabled}
          onCommit={onCommit}
          onCommitMember={onCommitMember}
        />
        {error && <div className="so-field-error">{error}</div>}
      </div>
    </div>
  );
}

/** State markers. Only shown when they change what the reader should do. */
function Chips({ row }: { row: SoRow }) {
  switch (row.state) {
    case 'migrated':
      return (
        <span className="so-field-chip so-field-chip-info" title={`Still stored as "${row.migratedFrom}"`}>
          <CornerDownRight size={9} />
          {row.migratedFrom}
        </span>
      );
    case 'unmapped':
      return (
        <span className="so-field-chip so-field-chip-warn" title="No longer declared in the C# class">
          stale
        </span>
      );
    case 'missing':
      return (
        <span className="so-field-chip so-field-chip-quiet" title="Declared in code, not yet written to this asset">
          not set
        </span>
      );
    case 'degraded':
      return (
        <span
          className="so-field-chip so-field-chip-warn"
          title="The stored value does not match the declared type — editing is disabled so a wrong write cannot happen"
        >
          <AlertTriangle size={9} />
          type
        </span>
      );
    default:
      return null;
  }
}

function Control({
  row,
  label,
  raw,
  disabled,
  onCommit,
  onCommitMember,
}: {
  row: SoRow;
  label: string;
  raw: string;
  disabled: boolean;
  onCommit: (draft: string) => void;
  onCommitMember: (member: string, draft: string) => void;
}) {
  const field = row.field;

  if (!row.editable || !field) {
    return <ReadOnly row={row} raw={raw} />;
  }

  switch (field.widget) {
    case 'bool':
      return (
        <Checkbox
          checked={raw.trim() === '1'}
          disabled={disabled}
          label={label}
          onChange={(next) => onCommit(next ? 'true' : 'false')}
        />
      );

    case 'enum':
      if (field.enumMembers && field.enumMembers.length > 0) {
        return (
          <select
            className="so-field-select"
            disabled={disabled}
            value={enumLabel(raw, field)}
            onChange={(e) => onCommit(e.target.value)}
          >
            {row.state === 'missing' && <option value="">—</option>}
            {field.enumMembers.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
              </option>
            ))}
          </select>
        );
      }
      return <TextControl raw={raw} disabled={disabled} onCommit={onCommit} numeric />;

    case 'enumFlags':
      return <TextControl raw={raw} disabled={disabled} onCommit={onCommit} numeric />;

    case 'vector2':
    case 'vector3':
    case 'vector4':
    case 'vector2Int':
    case 'vector3Int':
    case 'color':
      return (
        <div className="so-field-members">
          {field.widget === 'color' && <ColorSwatch members={row.value?.members ?? []} />}
          {(row.value?.members ?? []).map((m) => (
            <label key={m.name} className="so-field-member">
              <span className="so-field-member-name">{m.name}</span>
              <TextControl
                raw={m.raw}
                disabled={disabled}
                onCommit={(d) => onCommitMember(m.name, d)}
                numeric
              />
            </label>
          ))}
        </div>
      );

    case 'float':
    case 'int':
      return (
        <div className="so-field-number">
          <TextControl raw={raw} disabled={disabled} onCommit={onCommit} numeric />
          {field.range && (
            <span className="so-field-range">
              {field.range.min}–{field.range.max}
            </span>
          )}
        </div>
      );

    default:
      return <TextControl raw={toDisplay(raw, field)} disabled={disabled} onCommit={onCommit} />;
  }
}

/**
 * A value this inspector will not write.
 *
 * Rendered as what it MEANS, never as raw YAML in a box that looks editable.
 * An object reference resolves to the asset it names; a list says how many
 * items it has; the bytes stay in the tooltip for anyone who needs them.
 */
function ReadOnly({ row, raw }: { row: SoRow; raw: string }) {
  if (row.state === 'missing') {
    return <span className="so-field-readonly so-field-muted">default</span>;
  }

  const kind = row.value?.kind ?? 'scalar';

  // Object reference: the asset's name, clickable — not `{fileID: …, guid: …}`.
  const guid = GUID_RE.exec(raw)?.[1];
  if (guid) {
    return (
      <span className="so-field-ref" title={raw}>
        <Layers size={11} />
        <GuidRef guid={guid} />
      </span>
    );
  }
  if (FILE_ID_ZERO.test(raw.trim())) {
    return (
      <span className="so-field-readonly so-field-muted">
        <Link2Off size={11} /> None
      </span>
    );
  }

  // Lists and nested blocks: the useful fact is the count.
  if (kind === 'block' || kind === 'inlineSeq') {
    const summary = summarizeRaw(raw, kind);
    return (
      <span className="so-field-collection" title={raw}>
        <List size={11} />
        {summary || 'empty'}
      </span>
    );
  }

  if (!raw.trim()) return <span className="so-field-readonly so-field-muted">empty</span>;

  const display = row.field ? toDisplay(raw, row.field) : raw;
  return (
    <span className="so-field-readonly" title={raw}>
      {display}
    </span>
  );
}

/**
 * A boolean.
 *
 * Drawn rather than native: `accent-color` on an `<input type=checkbox>` gives
 * the browser's own control, filled with saturated candle gold — the loudest
 * element on a screen whose theme reserves that accent for ACTIVE STATES, not
 * for data. It also carries its own metrics, so it never sat on the row's
 * baseline with the other controls.
 *
 * Off, it recedes into the input surface. On, it is the accent at badge
 * strength with the tick carrying the colour — present, not shouting.
 */
function Checkbox({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`so-check${checked ? ' so-check-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      {checked && <Check size={11} strokeWidth={3} />}
    </button>
  );
}

/** A colour preview built from the inline map's r/g/b members. */
function ColorSwatch({ members }: { members: Array<{ name: string; raw: string }> }) {
  const c = (n: string) => {
    const v = Number(members.find((m) => m.name === n)?.raw ?? '0');
    return Number.isFinite(v) ? Math.round(Math.min(1, Math.max(0, v)) * 255) : 0;
  };
  return (
    <span
      className="so-field-swatch"
      style={{ background: `rgb(${c('r')}, ${c('g')}, ${c('b')})` }}
      aria-hidden="true"
    />
  );
}

/**
 * Uncontrolled until commit.
 *
 * The draft is local and only leaves on blur or Enter — a debounced write plus
 * a content hash is a race, because the hash the next keystroke would send is
 * the one the previous write just invalidated.
 */
function TextControl({
  raw,
  disabled,
  onCommit,
  numeric = false,
}: {
  raw: string;
  disabled: boolean;
  onCommit: (draft: string) => void;
  /** Machine value: monospaced, right-aligned, narrow. */
  numeric?: boolean;
}) {
  const [draft, setDraft] = useState(raw);
  // Re-sync when the file changes underneath (a reload, or another field's
  // write returning a fresh snapshot).
  useEffect(() => setDraft(raw), [raw]);

  return (
    <input
      type="text"
      className={`so-field-input${numeric ? ' so-field-input-num' : ''}`}
      disabled={disabled}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          setDraft(raw);
          e.currentTarget.blur();
        }
      }}
      spellCheck={false}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
    />
  );
}

export default SoFieldRow;
