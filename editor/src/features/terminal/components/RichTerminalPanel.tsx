import { useEffect } from 'react';
import { Plus, X, Eraser, Trash2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useTerminalStore } from '../../../stores/terminal';
import { useWorkspaceStore } from '../../../stores/workspace';
import TerminalInstance from './TerminalInstance';

function RichTerminalPanel() {
  const terminals = useTerminalStore((s) => s.terminals);
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const setActiveTerminal = useTerminalStore((s) => s.setActiveTerminal);
  const killTerminal = useTerminalStore((s) => s.killTerminal);
  const createTerminal = useTerminalStore((s) => s.createTerminal);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  // Auto-spawn the first session when the panel mounts with a workspace.
  useEffect(() => {
    if (terminals.length === 0 && workspacePath) {
      createTerminal(workspacePath);
    }
  }, [terminals.length, workspacePath, createTerminal]);

  function handleNew() {
    if (workspacePath) createTerminal(workspacePath);
  }

  function handleClear() {
    if (activeTerminalId === null) return;
    invoke('terminal_write', { id: activeTerminalId, data: '\x0c' }).catch(() => {});
  }

  return (
    <div className="vsterm">
      <div className="vsterm__rail">
        <div className="vsterm__tabs">
          {terminals.map((t) => {
            const isActive = t.id === activeTerminalId;
            return (
              <button
                key={t.id}
                className={`vsterm__tab${isActive ? ' is-active' : ''}${!t.isAlive ? ' is-exited' : ''}`}
                onClick={() => setActiveTerminal(t.id)}
                title={t.name}
              >
                <span className="vsterm__tab-name">{t.name}</span>
                <span
                  className="vsterm__tab-close"
                  role="button"
                  aria-label={`Close ${t.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    killTerminal(t.id);
                  }}
                >
                  <X size={11} aria-hidden="true" />
                </span>
              </button>
            );
          })}
          <button
            className="vsterm__add"
            onClick={handleNew}
            title="New Terminal"
            aria-label="New Terminal"
          >
            <Plus size={13} aria-hidden="true" />
          </button>
        </div>

        <div className="vsterm__actions">
          <button
            className="vsterm__action"
            onClick={handleClear}
            title="Clear (⌃L)"
            disabled={activeTerminalId === null}
          >
            <Eraser size={13} aria-hidden="true" />
          </button>
          <button
            className="vsterm__action"
            onClick={() => activeTerminalId !== null && killTerminal(activeTerminalId)}
            title="Kill terminal"
            disabled={activeTerminalId === null}
          >
            <Trash2 size={13} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="vsterm__surface">
        {terminals.length === 0 ? (
          <div className="vsterm__empty">
            <div className="vsterm__empty-text">No active terminal</div>
            <button
              className="vsterm__empty-cta"
              onClick={handleNew}
              disabled={!workspacePath}
            >
              <Plus size={13} aria-hidden="true" />
              <span>New Terminal</span>
            </button>
          </div>
        ) : (
          terminals.map((t) => (
            <div
              key={t.id}
              className="vsterm__instance"
              style={{ display: t.id === activeTerminalId ? 'flex' : 'none' }}
            >
              <TerminalInstance id={t.id} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default RichTerminalPanel;
