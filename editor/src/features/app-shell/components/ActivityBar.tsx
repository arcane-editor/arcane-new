import { Files, GitBranch, Search, Settings, Bug, Network, FlaskConical } from 'lucide-react';
import { useUiStore, type SidebarView } from '../../../stores/ui';
import { useCommandsStore } from '../../../stores/commands';
import { useProjectContextStore } from '../../../stores/project-context';
import { useSettingsStore } from '../../../stores/settings';
import { useGitStore } from '../../../stores/git';

const SIDEBAR_ITEMS: Array<{ id: SidebarView; icon: typeof Files; label: string }> = [
  { id: 'explorer', icon: Files, label: 'Explorer' },
  { id: 'search', icon: Search, label: 'Search' },
  { id: 'source-control', icon: GitBranch, label: 'Source Control' },
];

function ActivityBar() {
  const activeView = useUiStore((s) => s.activeSidebarView);
  const sidebarVisible = useUiStore((s) => s.sidebarVisible);
  const isUnityProject = useProjectContextStore((s) => s.isUnityProject);
  const debuggerEnabled = useSettingsStore((s) => s.getSetting('unity.debugger.enabled') !== false);
  const hierarchyEnabled = useSettingsStore((s) => s.getSetting('unity.hierarchyPanel.enabled') !== false);
  const testRunnerEnabled = useSettingsStore((s) => s.getSetting('unity.testRunner.enabled') !== false);

  // Narrow selector: only re-render when changed file count changes
  const changedCount = useGitStore((s) => {
    const allChanges = [...s.stagedFiles, ...s.unstagedFiles].map((f) => f.path);
    const uniquePaths = new Set(allChanges);
    return uniquePaths.size;
  });

  const items: typeof SIDEBAR_ITEMS = [
    ...SIDEBAR_ITEMS,
    ...(isUnityProject && hierarchyEnabled
      ? [{ id: 'hierarchy' as SidebarView, icon: Network, label: 'Unity Hierarchy' }]
      : []),
    ...(isUnityProject && testRunnerEnabled
      ? [{ id: 'test' as SidebarView, icon: FlaskConical, label: 'Unity Tests' }]
      : []),
    ...(isUnityProject && debuggerEnabled
      ? [{ id: 'debug' as SidebarView, icon: Bug, label: 'Run and Debug' }]
      : []),
  ];

  return (
    <div className="activity-bar">
      {items.map(({ id, icon: Icon, label }) => (
        <button
          key={id}
          className={`activity-bar-icon${activeView === id && sidebarVisible ? ' active' : ''}`}
          onClick={() => {
            const ui = useUiStore.getState();
            if (id === ui.activeSidebarView && ui.sidebarVisible) {
              ui.setSidebarVisible(false);
            } else {
              ui.setActiveSidebarView(id);
              ui.setSidebarVisible(true);
            }
          }}
          title={label}
        >
          <Icon size={24} />
          {id === 'source-control' && changedCount > 0 && (
            <div
              style={{
                position: 'absolute',
                top: '-2px',
                right: '-2px',
                background: 'var(--accent)',
                color: 'var(--text-active)',
                borderRadius: '50%',
                minWidth: '18px',
                height: '18px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '9px',
                fontWeight: 600,
                padding: '0 3px',
              }}
            >
              {changedCount > 99 ? '99+' : changedCount}
            </div>
          )}
        </button>
      ))}

      <div className="activity-bar-bottom">
        <button
          className="activity-bar-icon"
          onClick={() => useCommandsStore.getState().executeCommand('settings.open')}
          title="Settings"
        >
          <Settings size={24} />
        </button>
      </div>
    </div>
  );
}

export default ActivityBar;
