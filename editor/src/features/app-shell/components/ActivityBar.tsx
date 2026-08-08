import { Files, GitBranch, Search, Settings, Bug, Network, FlaskConical, SquareTerminal } from 'lucide-react';
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
  const bottomPanelVisible = useUiStore((s) => s.bottomPanelVisible);
  const activeBottomTab = useUiStore((s) => s.activeBottomTab);
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
            <span className="activity-bar-badge">
              {changedCount > 99 ? '99+' : changedCount}
            </span>
          )}
        </button>
      ))}

      <div className="activity-bar-bottom">
        {/* The terminal had no button at all — it was reachable only by
            Cmd+` or the palette, which is the discoverability gap reported in
            docs/superpowers/specs/2026-08-02-onboarding-unity-visibility-design.md
            ("they had to be told that Ctrl+J reveals the terminal"). */}
        <button
          className={`activity-bar-icon${
            bottomPanelVisible && activeBottomTab === 'terminal' ? ' active' : ''
          }`}
          onClick={() => {
            const ui = useUiStore.getState();
            // Panel already open on another tab (e.g. Problems): bring the
            // terminal forward rather than hiding the panel. Hiding is what a
            // blind toggle would do, and it is never what clicking a button
            // labelled "Terminal" means.
            if (ui.bottomPanelVisible && ui.activeBottomTab !== 'terminal') {
              ui.setActiveBottomTab('terminal');
              return;
            }
            // Otherwise defer to the command, which also spawns the first
            // terminal when none exists yet.
            useCommandsStore.getState().executeCommand('terminal.toggle');
          }}
          title="Terminal (Cmd+`)"
        >
          <SquareTerminal size={24} />
        </button>
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
