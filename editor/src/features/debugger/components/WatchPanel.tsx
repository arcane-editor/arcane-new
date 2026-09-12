import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { VarRow } from './VariablesPanel';
import { useDebugStore } from '../../../stores/debug';

/** Watch expressions, evaluated against the selected frame when paused. */
export function WatchPanel() {
  const watches = useDebugStore((s) => s.watches);
  const results = useDebugStore((s) => s.watchResults);
  const variables = useDebugStore((s) => s.watchVariables);
  const [draft, setDraft] = useState('');

  const add = () => {
    const expr = draft.trim();
    if (!expr) return;
    useDebugStore.getState().addWatch(expr);
    setDraft('');
  };

  return (
    <div className="dbg-watch">
      <div className="dbg-watch-add">
        <input
          value={draft}
          placeholder="Add expression…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        />
        <button onClick={add} title="Add watch"><Plus size={13} /></button>
      </div>
      {watches.map((expr) => (
        <div key={expr} className="dbg-watch-row">
          <div style={{ flex: 1, minWidth: 0 }}><VarRow node={variables.get(expr) ?? { name: expr, value: results.get(expr) ?? '…', variablesReference: 0 }} depth={0} containerRef={0} /></div>
          <button className="dbg-watch-del" onClick={() => useDebugStore.getState().removeWatch(expr)} title="Remove">
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
