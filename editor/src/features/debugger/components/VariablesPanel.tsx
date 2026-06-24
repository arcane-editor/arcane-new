import { useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { useDebugStore, type VariableNode } from '../../../stores/debug';
import { renderValue } from '../services/value-rendering';

/** A single variable row, lazily expandable when variablesReference > 0. */
function VarRow({ node, depth }: { node: VariableNode; depth: number }) {
  const [open, setOpen] = useState(false);
  const children = useDebugStore((s) => s.variables.get(node.variablesReference));
  const expandable = node.variablesReference > 0;
  const rendered = renderValue(node);

  const toggle = async () => {
    if (!expandable) return;
    if (!open && !children) await useDebugStore.getState().loadChildren(node.variablesReference);
    setOpen((o) => !o);
  };

  return (
    <>
      <div className="dbg-var" style={{ paddingLeft: 6 + depth * 12 }} onClick={toggle}>
        <span className="dbg-var-twisty">
          {expandable ? (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : null}
        </span>
        <span className="dbg-var-name">{node.name}</span>
        <span className="dbg-var-eq">:</span>
        {rendered.swatch && (
          <span className="dbg-var-swatch" style={{ background: rendered.swatch }} />
        )}
        <span className="dbg-var-value" title={node.type}>{rendered.display}</span>
      </div>
      {open && children?.map((c, i) => <VarRow key={`${c.name}-${i}`} node={c} depth={depth + 1} />)}
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
            <VarRow key={`${v.name}-${i}`} node={v} depth={0} />
          ))}
        </div>
      ))}
    </div>
  );
}
