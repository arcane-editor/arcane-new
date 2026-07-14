import { X } from 'lucide-react';
import { useUiStore, type BottomPanelTab } from '../../../stores/ui';
import { useProjectContextStore } from '../../../stores/project-context';
import { RichTerminalPanel } from '../../terminal';
import { UnityConsolePanel } from '../../unity-console';
import ProblemsPanel from './ProblemsPanel';

function BottomPanel() {
  const activeTab = useUiStore((s) => s.activeBottomTab);
  const setActiveTab = useUiStore((s) => s.setActiveBottomTab);
  const setBottomPanelVisible = useUiStore((s) => s.setBottomPanelVisible);
  const isUnityProject = useProjectContextStore((s) => s.isUnityProject);

  // Terminal, Problems and Output are always present. Unity projects
  // additionally get a Unity Console tab alongside the real terminal.
  const tabs: Array<{ id: BottomPanelTab; label: string }> = [
    { id: 'terminal', label: 'Terminal' },
    ...(isUnityProject ? [{ id: 'unity-console' as BottomPanelTab, label: 'Unity Console' }] : []),
    { id: 'problems', label: 'Problems' },
    { id: 'output', label: 'Output' },
  ];

  // The stored active tab may be one that isn't available in the current
  // project (e.g. a stale 'unity-console' selection left over after switching
  // to a plain folder). Fall back to the first available tab so the panel
  // never renders blank. (The initial store default is 'unity-console' so
  // that Unity projects still land on Unity Console first — see stores/ui.ts.)
  const effectiveTab = tabs.some((t) => t.id === activeTab) ? activeTab : tabs[0].id;

  return (
    <div className="bottom-panel">
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
        <button
          className="bottom-panel-close"
          title="Close Panel"
          onClick={() => setBottomPanelVisible(false)}
        >
          <X size={14} />
        </button>
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
          <RichTerminalPanel />
        </div>
        {effectiveTab === 'unity-console' && <UnityConsolePanel />}
        {effectiveTab === 'problems' && <ProblemsPanel />}
        {effectiveTab === 'output' && (
          <div className="panel-stub">No output</div>
        )}
      </div>
    </div>
  );
}

export default BottomPanel;
