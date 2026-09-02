import { useEffect, useState } from 'react';
import { AlertTriangle, CornerDownRight, Link2Off } from 'lucide-react';
import { GuidRef } from '../../unity-asset-viewer';
import type { SoRow } from '../services/so-value-model';
import { enumLabel, toDisplay } from '../services/so-value-format';

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
  const label = row.field?.name ?? row.yamlKey;
  const raw = row.value?.raw ?? '';

  return (
    <div className={`so-field-row${error ? ' so-field-row-error' : ''}`}>
      <div className="so-field-label" title={row.field?.tooltip ?? row.field?.csharpType ?? row.yamlKey}>
        <span className="so-field-name">{label}</span>
        {row.state === 'migrated' && (
          <span className="so-field-chip so-field-chip-info" title={`Still stored as "${row.migratedFrom}"`}>
            <CornerDownRight size={10} /> {row.migratedFrom}
          </span>
        )}
        {row.state === 'unmapped' && (
          <span className="so-field-chip so-field-chip-warn" title="No longer declared in the C# class">
            stale
          </span>
        )}
        {row.state === 'missing' && (
          <span className="so-field-chip so-field-chip-warn" title="Declared in code, not yet in this asset">
            not set
          </span>
        )}
        {row.state === 'degraded' && (
          <span className="so-field-chip so-field-chip-warn" title="The stored value does not match the declared type">
            <AlertTriangle size={10} /> shape
          </span>
        )}
      </div>

      <div className="so-field-control">
        <Control
          row={row}
          raw={raw}
          disabled={disabled}
          onCommit={onCommit}
          onCommitMember={onCommitMember}
        />
        {error && <div className="so-field-error">{error}</div>}
      </div>
    </div>
  );
}

function Control({
  row,
  raw,
  disabled,
  onCommit,
  onCommitMember,
}: {
  row: SoRow;
  raw: string;
  disabled: boolean;
  onCommit: (draft: string) => void;
  onCommitMember: (member: string, draft: string) => void;
}) {
  const field = row.field;

  // Anything we will not write renders as its literal bytes, so the user can
  // still see the truth even when the inspector cannot edit it.
  if (!row.editable || !field) {
    if (row.state === 'missing') {
      return <span className="so-field-readonly so-field-default">default</span>;
    }
    const guid = GUID_RE.exec(raw)?.[1];
    if (guid) {
      return (
        <span className="so-field-readonly">
          <GuidRef guid={guid} />
        </span>
      );
    }
    if (FILE_ID_ZERO.test(raw.trim())) {
      return (
        <span className="so-field-readonly so-field-none">
          <Link2Off size={11} /> None
        </span>
      );
    }
    return <span className="so-field-readonly">{raw || '—'}</span>;
  }

  switch (field.widget) {
    case 'bool':
      return (
        <input
          type="checkbox"
          className="so-field-checkbox"
          disabled={disabled}
          checked={raw.trim() === '1'}
          onChange={(e) => onCommit(e.target.checked ? 'true' : 'false')}
        />
      );

    case 'enum':
    case 'enumFlags':
      if (field.enumMembers && field.enumMembers.length > 0 && field.widget === 'enum') {
        return (
          <select
            className="so-field-select"
            disabled={disabled}
            value={enumLabel(raw, field)}
            onChange={(e) => onCommit(e.target.value)}
          >
            {field.enumMembers.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
              </option>
            ))}
          </select>
        );
      }
      return <TextControl raw={raw} disabled={disabled} onCommit={onCommit} mono />;

    case 'vector2':
    case 'vector3':
    case 'vector4':
    case 'vector2Int':
    case 'vector3Int':
    case 'color':
      return (
        <div className="so-field-members">
          {(row.value?.members ?? []).map((m) => (
            <label key={m.name} className="so-field-member">
              <span className="so-field-member-name">{m.name}</span>
              <TextControl
                raw={m.raw}
                disabled={disabled}
                onCommit={(d) => onCommitMember(m.name, d)}
                mono
                compact
              />
            </label>
          ))}
        </div>
      );

    case 'float':
    case 'int':
      return (
        <div className="so-field-number">
          <TextControl raw={raw} disabled={disabled} onCommit={onCommit} mono compact />
          {field.range && (
            <span className="so-field-range">
              {field.range.min} – {field.range.max}
            </span>
          )}
        </div>
      );

    default:
      return <TextControl raw={toDisplay(raw, field)} disabled={disabled} onCommit={onCommit} />;
  }
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
  mono = false,
  compact = false,
}: {
  raw: string;
  disabled: boolean;
  onCommit: (draft: string) => void;
  mono?: boolean;
  compact?: boolean;
}) {
  const [draft, setDraft] = useState(raw);
  // Re-sync when the file changes underneath (a reload, or another field's
  // write returning a fresh snapshot).
  useEffect(() => setDraft(raw), [raw]);

  return (
    <input
      type="text"
      className={`so-field-input${mono ? ' so-field-input-mono' : ''}${compact ? ' so-field-input-compact' : ''}`}
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
