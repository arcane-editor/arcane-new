import { useEffect } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useUiStore, type BottomPanelTab } from '../../../stores/ui';
import { useProjectContextStore } from '../../../stores/project-context';
import { RichTerminalPanel } from '../../terminal';
import { UnityConsolePanel } from '../../unity-console';
import ProblemsPanel from './ProblemsPanel';

function BottomPanel() {
  const activeTab = useUiStore((s) => s.activeBottomTab);
  const setActiveTab = useUiStore((s) => s.setActiveBottomTab);
  const setBottomPanelVisible = useUiStore((s) => s.setBottomPanelVisible);
  // App.tsx keeps this component mounted even while the panel is closed (via
  // Allotment's `visible`, so live terminals aren't disposed), so "the panel is
  // open" is no longer implied by "we are rendering".
  const panelVisible = useUiStore((s) => s.bottomPanelVisible);
  const maximized = useUiStore((s) => s.bottomPanelMaximized);
  const toggleMaximized = useUiStore((s) => s.toggleBottomPanelMaximized);
  const setMaximized = useUiStore((s) => s.setBottomPanelMaximized);
  const isUnityProject = useProjectContextStore((s) => s.isUnityProject);

  // While maximized, Escape restores normal height — except when focus is
  // inside a live terminal session (e.g. vim, a TUI), where Escape is a
  // meaningful keystroke for the running program and must not bubble up to
  // collapse the panel. Listener is added/removed with the maximized state,
  // mirroring MaximizedAiOverlay's effect shape.
  useEffect(() => {
    if (!maximized) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if ((e.target as HTMLElement).closest?.('.terminal-xterm')) return;
      setMaximized(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [maximized, setMaximized]);

  // Terminal, Problems and Output are always present. Unity projects
  // additionally get a Unity Console tab alongside the real terminal.
  const tabs: Array<{ id: BottomPanelTab; label: string }> = [
    { id: 'terminal', label: 'Terminal' },
    ...(isUnityProject ? [{ id: 'unity-console' as BottomPanelTab, label: 'Unity Console' }] : []),
    { id: 'problems', label: 'Problems' },
  ];

  // The stored active tab may be one that isn't available in the current
  // project (e.g. a stale 'unity-console' selection left over after switching
  // to a plain folder). Fall back to the first available tab so the panel
  // never renders blank. (The initial store default is 'unity-console' so
  // that Unity projects still land on Unity Console first — see stores/ui.ts.)
  const effectiveTab = tabs.some((t) => t.id === activeTab) ? activeTab : tabs[0].id;

  return (
    <div className={`bottom-panel${maximized ? ' bottom-panel--maximized' : ''}`}>
      <div className="bottom-panel-header">
        <div className="bottom-panel-tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`bottom-panel-tab${effectiveTab === tab.id ? ' active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="bottom-panel-actions">
          <button
            className="bottom-panel-maximize"
            title={maximized ? 'Restore Panel (Cmd+Shift+J)' : 'Maximize Panel (Cmd+Shift+J)'}
            onClick={() => toggleMaximized()}
          >
            {maximized ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </button>
          <button
            className="bottom-panel-close"
            title="Close Panel"
            onClick={() => setBottomPanelVisible(false)}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="bottom-panel-content">
        {/* The terminal stays mounted across tab switches (display-toggled,
            never unmounted) so its xterm instances — and their scrollback —
            survive switching to Problems/Output/Unity Console and back. This
            mirrors how RichTerminalPanel itself keeps each terminal instance
            alive via display toggling instead of conditional rendering. */}
        <div
          className="bottom-panel-terminal-slot"
          style={{ display: effectiveTab === 'terminal' ? 'flex' : 'none' }}
        >
          {/* `isVisible` gates auto-spawn, so it must mean "revealed to the
              user", not merely "mounted" — this component now stays mounted
              while the panel is closed. Without the panelVisible term a PTY
              would spawn at boot with the panel shut, which is exactly what
              gating auto-spawn on tab reveal was added to prevent. */}
          <RichTerminalPanel isVisible={panelVisible && effectiveTab === 'terminal'} />
        </div>
        {effectiveTab === 'unity-console' && <UnityConsolePanel />}
        {effectiveTab === 'problems' && <ProblemsPanel />}
      </div>
    </div>
  );
}

export default BottomPanel;
