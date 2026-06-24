import { Plus, X } from 'lucide-react';
import { useTerminalStore } from '../../../stores/terminal';
import { useWorkspaceStore } from '../../../stores/workspace';

function TerminalTabs() {
  const terminals = useTerminalStore((s) => s.terminals);
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const setActiveTerminal = useTerminalStore((s) => s.setActiveTerminal);
  const killTerminal = useTerminalStore((s) => s.killTerminal);
  const createTerminal = useTerminalStore((s) => s.createTerminal);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  function handleNewTerminal() {
    if (workspacePath) {
      createTerminal(workspacePath);
    }
  }

  return (
    <div className="terminal-tabs">
      {terminals.map((t) => (
        <button
          key={t.id}
          className={`terminal-tab${t.id === activeTerminalId ? ' active' : ''}${!t.isAlive ? ' exited' : ''}`}
          onClick={() => setActiveTerminal(t.id)}
        >
          <span className="terminal-tab-name">{t.name}</span>
          <span
            className="terminal-tab-close"
            onClick={(e) => {
              e.stopPropagation();
              killTerminal(t.id);
            }}
          >
            <X size={12} />
          </span>
        </button>
      ))}
      <button
        className="terminal-add-btn"
        title="New Terminal"
        onClick={handleNewTerminal}
      >
        <Plus size={14} />
      </button>
    </div>
  );
}

export default TerminalTabs;
