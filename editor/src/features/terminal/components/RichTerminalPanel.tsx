import { useEffect } from 'react';
import { Plus, X, Eraser, Trash2, SquareSplitHorizontal } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { Allotment } from 'allotment';
import { useTerminalStore } from '../../../stores/terminal';
import { useWorkspaceStore } from '../../../stores/workspace';
import { focusTerminalById } from '../terminal-registry';
import TerminalInstance from './TerminalInstance';

interface RichTerminalPanelProps {
  /**
   * Whether the terminal slot is actually revealed in the bottom panel.
   * BottomPanel keeps this component mounted at all times (display-toggled,
   * never unmounted) so xterm scrollback survives switching to
   * Problems/Unity Console/Output and back — which means a plain
   * mount-effect would auto-spawn an idle PTY any time the bottom panel
   * opens on another tab. Gating on this prop instead spawns on first
   * reveal of the terminal tab itself.
   */
  isVisible: boolean;
}

function RichTerminalPanel({ isVisible }: RichTerminalPanelProps) {
  const terminals = useTerminalStore((s) => s.terminals);
  const groups = useTerminalStore((s) => s.groups);
  const activeGroupId = useTerminalStore((s) => s.activeGroupId);
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const setActiveTerminal = useTerminalStore((s) => s.setActiveTerminal);
  const setActiveGroup = useTerminalStore((s) => s.setActiveGroup);
  const killTerminal = useTerminalStore((s) => s.killTerminal);
  const killGroup = useTerminalStore((s) => s.killGroup);
  const createTerminal = useTerminalStore((s) => s.createTerminal);
  const splitTerminal = useTerminalStore((s) => s.splitTerminal);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  // Auto-spawn the first session on first reveal of the terminal tab (not on
  // mount — see isVisible doc above).
  useEffect(() => {
    if (isVisible && groups.length === 0 && workspacePath) {
      createTerminal(workspacePath);
    }
  }, [isVisible, groups.length, workspacePath, createTerminal]);

  // Tab switches (clicking a tab, closing the active tab/pane, splitting)
  // change `activeGroupId` — move REAL keyboard focus into the newly active
  // group's focused pane so typing works immediately, without an extra
  // click. This only needs to react to the GROUP changing: intra-group pane
  // switches already move real focus themselves — a mouse click on another
  // split bubbles DOM focus naturally (`.vsterm__pane`'s `onFocusCapture`
  // just syncs store state to match), and the focus-next/previous-pane
  // commands call `focusTerminalById` directly from their handlers.
  useEffect(() => {
    if (activeGroupId !== null && activeTerminalId !== null) {
      focusTerminalById(activeTerminalId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGroupId]);

  function handleNew() {
    if (workspacePath) createTerminal(workspacePath);
  }

  function handleSplit() {
    if (activeTerminalId === null) return;
    // Mirrors the `terminal.split` command handler in App.tsx: a same-group
    // split doesn't change `activeGroupId`, so the tab-switch focus effect
    // above won't fire for it — move real keyboard focus into the new pane
    // directly once it exists.
    splitTerminal(activeTerminalId).then((newId) => {
      if (newId !== null) focusTerminalById(newId);
    });
  }

  function handleClear() {
    if (activeTerminalId === null) return;
    invoke('terminal_write', { id: activeTerminalId, data: '\x0c' }).catch(() => {});
  }

  return (
    <div className="vsterm">
      <div className="vsterm__rail">
        <div className="vsterm__tabs">
          {groups.map((group) => {
            const isActive = group.id === activeGroupId;
            const first = terminals.find((t) => t.id === group.terminalIds[0]);
            const label = first?.name ?? 'terminal';
            const extraCount = group.terminalIds.length - 1;
            // Dim the tab only once EVERY pane in the group has exited —
            // a split group with one live pane and one exited pane is still
            // a "live" tab.
            const allExited = group.terminalIds.every((tid) => {
              const t = terminals.find((x) => x.id === tid);
              return t ? !t.isAlive : true;
            });
            return (
              <button
                key={group.id}
                className={`vsterm__tab${isActive ? ' is-active' : ''}${allExited ? ' is-exited' : ''}`}
                onClick={() => setActiveGroup(group.id)}
                title={label}
              >
                <span className="vsterm__tab-name">
                  {label}
                  {extraCount > 0 && <span className="vsterm__tab-badge">+{extraCount}</span>}
                </span>
                <span
                  className="vsterm__tab-close"
                  role="button"
                  aria-label={`Close ${label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    killGroup(group.id);
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
            onClick={handleSplit}
            title="Split Terminal (⌘\\)"
            disabled={activeTerminalId === null}
          >
            <SquareSplitHorizontal size={13} aria-hidden="true" />
          </button>
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
            title="Kill pane"
            disabled={activeTerminalId === null}
          >
            <Trash2 size={13} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="vsterm__surface">
        {groups.length === 0 ? (
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
          groups.map((group) => (
            <div
              key={group.id}
              className="vsterm__group"
              style={{ display: group.id === activeGroupId ? 'flex' : 'none' }}
            >
              {/* ALWAYS wrap panes in an Allotment, even for a single pane
                  (n=1) — load-bearing. Introducing the Allotment wrapper
                  only once a group is actually split would change the tree
                  shape for the surviving pane (its parent would go from a
                  plain div straight to Allotment.Pane), remounting the
                  TerminalInstance beneath it — which disposes and recreates
                  the xterm instance, losing scrollback. Keeping the wrapper
                  present from n=1 onward means splitting/closing panes only
                  ever changes sibling count, never the surviving pane's own
                  position in the tree. */}
              <Allotment>
                {group.terminalIds.map((tid) => {
                  const isFocused = tid === group.focusedId;
                  const showFocusRing = group.terminalIds.length > 1 && isFocused;
                  return (
                    <Allotment.Pane key={tid}>
                      <div
                        className={`vsterm__pane${showFocusRing ? ' is-focused' : ''}`}
                        // xterm's hidden helper-textarea is what actually
                        // receives focus; capture phase catches that bubble
                        // so clicking anywhere in an inactive split makes it
                        // the focused pane (and active group, via focusPane).
                        onFocusCapture={() => setActiveTerminal(tid)}
                      >
                        <TerminalInstance id={tid} />
                      </div>
                    </Allotment.Pane>
                  );
                })}
              </Allotment>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default RichTerminalPanel;
