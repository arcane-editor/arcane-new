import { useState, useRef, useEffect } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { useDebugStore, type VariableNode } from '../../../stores/debug';
import { renderValue } from '../services/value-rendering';

/**
 * A single variable row, lazily expandable when variablesReference > 0.
 *
 * `containerRef` is the variablesReference of the container this row was
 * fetched from — NOT `node.variablesReference`, which points at the row's own
 * children. `setVariable` addresses a variable by (container, name), so
 * without this a row has no way to say where it lives and nothing could be
 * edited.
 */
function VarRow({
  node,
  depth,
  containerRef,
}: {
  node: VariableNode;
  depth: number;
  containerRef: number;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const children = useDebugStore((s) => s.variables.get(node.variablesReference));
  const canEdit = useDebugStore((s) => s.capabilities.supportsSetVariable === true);
  const expandable = node.variablesReference > 0;
  const rendered = renderValue(node);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const toggle = async () => {
    if (editing) return;
    if (!expandable) return;
    if (!open && !children) await useDebugStore.getState().loadChildren(node.variablesReference);
    setOpen((o) => !o);
  };

  const beginEdit = (e: React.MouseEvent) => {
    if (!canEdit) return;
    e.stopPropagation(); // don't toggle expansion on the double-click
    // Seed from the RAW value, not `rendered.display`: renderValue is lossy
    // (it trims float precision and rewrites Vector3/Color into a friendlier
    // form), so editing from the display string would silently truncate.
    setDraft(node.value);
    setEditing(true);
  };

  const commit = async () => {
    setEditing(false);
    if (draft === node.value) return;
    await useDebugStore.getState().setVariable(containerRef, node.name, draft);
  };

  return (
    <>
      <div className="dbg-var" style={{ paddingLeft: 6 + depth * 12 }} onClick={toggle}>
        <span className="dbg-var-twisty">
          {expandable ? (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : null}
        </span>
        <span className="dbg-var-name">{node.name}</span>
        <span className="dbg-var-eq">:</span>
        {rendered.swatch && !editing && (
          <span className="dbg-var-swatch" style={{ background: rendered.swatch }} />
        )}
        {editing ? (
          <input
            ref={inputRef}
            className="dbg-var-edit"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
              // Stop these reaching the document-level hotkey manager while an
              // edit is in flight, but do NOT blanket-stopPropagation: React
              // listens below the document listener, so killing every key here
              // would disable app hotkeys for as long as this input has focus.
              if (e.key === 'Enter') {
                e.preventDefault();
                void commit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setEditing(false);
              }
            }}
          />
        ) : (
          <span
            className={`dbg-var-value${canEdit ? ' dbg-var-value--editable' : ''}`}
            title={canEdit ? `${node.type ?? ''} — double-click to change`.trim() : node.type}
            onDoubleClick={beginEdit}
          >
            {rendered.display}
          </span>
        )}
      </div>
      {open &&
        children?.map((c, i) => (
          <VarRow
            key={`${c.name}-${i}`}
            node={c}
            depth={depth + 1}
            containerRef={node.variablesReference}
          />
        ))}
    </>
  );
}

/** Locals/Scopes for the selected stack frame. */
export function VariablesPanel() {
  const scopes = useDebugStore((s) => s.scopes);
  const variables = useDebugStore((s) => s.variables);
  const status = useDebugStore((s) => s.status);

  if (status !== 'paused') return <div className="dbg-section-empty">Variables appear when paused.</div>;
  if (scopes.length === 0) return <div className="dbg-section-empty">No variables.</div>;

  return (
    <div className="dbg-variables">
      {scopes.map((scope) => (
        <div key={scope.variablesReference} className="dbg-scope">
          <div className="dbg-scope-name">{scope.name}</div>
          {(variables.get(scope.variablesReference) ?? []).map((v, i) => (
            <VarRow
              key={`${v.name}-${i}`}
              node={v}
              depth={0}
              containerRef={scope.variablesReference}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
