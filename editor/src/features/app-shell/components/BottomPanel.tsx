import { X } from 'lucide-react';
import { useUiStore, type BottomPanelTab } from '../../../stores/ui';
import { useTerminalStore } from '../../../stores/terminal';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useProjectContextStore } from '../../../stores/project-context';
import { TerminalTabs, TerminalInstance, RichTerminalPanel } from '../../terminal';
import { UnityConsolePanel } from '../../unity-console';
import ProblemsPanel from './ProblemsPanel';

function BottomPanel() {
  const activeTab = useUiStore((s) => s.activeBottomTab);
  const setActiveTab = useUiStore((s) => s.setActiveBottomTab);
  const setBottomPanelVisible = useUiStore((s) => s.setBottomPanelVisible);
  const terminals = useTerminalStore((s) => s.terminals);
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const isUnityProject = useProjectContextStore((s) => s.isUnityProject);

  // Problems and Output are always present. The first tab is Terminal for plain
  // folders, but in a Unity project the Terminal tab is replaced by Unity
  // Console (which takes the leading position).
  const tabs: Array<{ id: BottomPanelTab; label: string }> = [
    isUnityProject
      ? { id: 'unity-console', label: 'Unity Console' }
      : { id: 'terminal', label: 'Terminal' },
    { id: 'problems', label: 'Problems' },
    { id: 'output', label: 'Output' },
  ];

  // The stored active tab may be one that isn't available in the current
  // project (e.g. 'terminal' left over after opening a Unity project, or
  // 'unity-console' left over after switching to a plain folder). Fall back to
  // the first available tab so the panel never renders blank.
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
        {effectiveTab === 'terminal' && (
          isUnityProject ? (
            <TerminalContent
              terminals={terminals}
              activeTerminalId={activeTerminalId}
            />
          ) : (
            <RichTerminalPanel />
          )
        )}
        {effectiveTab === 'unity-console' && <UnityConsolePanel />}
        {effectiveTab === 'problems' && <ProblemsPanel />}
        {effectiveTab === 'output' && (
          <div className="panel-stub">No output</div>
        )}
      </div>
    </div>
  );
}

function TerminalContent({
  terminals,
  activeTerminalId,
}: {
  terminals: ReturnType<typeof useTerminalStore.getState>['terminals'];
  activeTerminalId: number | null;
}) {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const createTerminal = useTerminalStore((s) => s.createTerminal);

  // Auto-create first terminal
  if (terminals.length === 0 && workspacePath) {
    // Use setTimeout to avoid calling during render
    setTimeout(() => {
      if (useTerminalStore.getState().terminals.length === 0) {
        createTerminal(workspacePath);
      }
    }, 0);
  }

  return (
    <>
      <TerminalTabs />
      <div className="terminal-instances">
        {terminals.map((t) => (
          <div
            key={t.id}
            className="terminal-instance"
            style={{ display: t.id === activeTerminalId ? 'flex' : 'none' }}
          >
            <TerminalInstance id={t.id} />
          </div>
        ))}
      </div>
    </>
  );
}

export default BottomPanel;
