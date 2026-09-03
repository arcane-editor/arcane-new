import { Files, GitBranch, Search, Settings, Bug, Network, FlaskConical, SquareTerminal, Gamepad2, Boxes, PanelsTopLeft } from 'lucide-react';
import Tooltip from '../../../components/Tooltip';
import { useUiStore, type SidebarView } from '../../../stores/ui';
import { useCommandsStore } from '../../../stores/commands';
import { useProjectContextStore } from '../../../stores/project-context';
import { useSettingsStore } from '../../../stores/settings';
import { useGitStore } from '../../../stores/git';
import { isNewInputSystemActive } from '../../../utils/input-system';

// `commandId` is what supplies the chord in the tooltip. Never spell a chord
// into `label`: it goes stale the moment the binding moves, and five tooltips
// in this app hardcoded macOS glyphs that Windows users were shown verbatim.
interface ActivityItem {
  id: SidebarView;
  icon: typeof Files;
  label: string;
  commandId?: string;
}

const SIDEBAR_ITEMS: ActivityItem[] = [
  { id: 'explorer', icon: Files, label: 'Explorer', commandId: 'view.explorer' },
  { id: 'search', icon: Search, label: 'Search', commandId: 'search.openTab' },
  { id: 'source-control', icon: GitBranch, label: 'Source Control', commandId: 'view.sourceControl' },
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
  const inputHubEnabled = useSettingsStore((s) => s.getSetting('unity.inputHub.enabled') !== false);
  const soBrowserEnabled = useSettingsStore((s) => s.getSetting('unity.scriptableObjects.browser') !== false);
  const unityUiEnabled = useSettingsStore((s) => s.getSetting('unity.uiToolkit.panel') !== false);
  // The Input Hub is meaningless under the legacy Input Manager -- there are
  // no .inputactions assets to edit and no action names to resolve -- so the
  // icon is absent rather than present-and-empty. `inputSystem` is null until
  // detection lands, which keeps the icon from flashing in on project open.
  const inputSystemActive = useProjectContextStore((s) => isNewInputSystemActive(s.inputSystem));

  // Narrow selector: only re-render when the changed-file count changes.
  //
  // Counted in a single pass with a reused Set rather than building two
  // intermediate arrays. This selector runs on EVERY git store write — and the
  // file watcher drives those continuously in a Unity project — so allocating
  // two arrays and a Set each time was pure garbage on a hot path.
  const changedCount = useGitStore((s) => {
    const seen = new Set<string>();
    for (const f of s.stagedFiles) seen.add(f.path);
    for (const f of s.unstagedFiles) seen.add(f.path);
    return seen.size;
  });

  // Read the chord back out of the registry rather than writing it here. The
  // tooltip used to hardcode "Cmd+`" and went stale the moment the binding
  // moved; formatKeybinding is the same formatter the onboarding signpost uses.
  const items: ActivityItem[] = [
    ...SIDEBAR_ITEMS,
    ...(isUnityProject && hierarchyEnabled
      ? [{ id: 'hierarchy' as SidebarView, icon: Network, label: 'Unity Hierarchy', commandId: 'view.hierarchy' }]
      : []),
    ...(isUnityProject && soBrowserEnabled
      ? [{ id: 'scriptable-objects' as SidebarView, icon: Boxes, label: 'Scriptable Objects', commandId: 'view.scriptableObjects' }]
      : []),
    ...(isUnityProject && testRunnerEnabled
      ? [{ id: 'test' as SidebarView, icon: FlaskConical, label: 'Unity Tests', commandId: 'view.testRunner' }]
      : []),
    ...(isUnityProject && inputSystemActive && inputHubEnabled
      ? [{ id: 'input' as SidebarView, icon: Gamepad2, label: 'Input Actions', commandId: 'view.inputHub' }]
      : []),
    ...(isUnityProject && unityUiEnabled
      ? [{ id: 'unity-ui' as SidebarView, icon: PanelsTopLeft, label: 'Unity UI', commandId: 'view.unityUi' }]
      : []),
    ...(isUnityProject && debuggerEnabled
      ? [{ id: 'debug' as SidebarView, icon: Bug, label: 'Run and Debug', commandId: 'view.debug' }]
      : []),
  ];

  return (
    <div className="activity-bar">
      {items.map(({ id, icon: Icon, label, commandId }) => (
        <Tooltip key={id} label={label} commandId={commandId}>
          <button
            data-coach={id}
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
          >
            <Icon size={18} />
            {id === 'source-control' && changedCount > 0 && (
              <span className="activity-bar-badge">
                {changedCount > 99 ? '99+' : changedCount}
              </span>
            )}
          </button>
        </Tooltip>
      ))}

      <div className="activity-bar-bottom">
        {/* The terminal had no button at all — keyboard or palette only, which
            is the discoverability gap reported in
            docs/superpowers/specs/2026-08-02-onboarding-unity-visibility-design.md
            ("they had to be told that Ctrl+J reveals the terminal"). The chord
            in the tooltip below is read back out of the command registry, so it
            cannot drift from the real binding the way a hardcoded one did. */}
        <Tooltip label="Terminal" commandId="terminal.toggle">
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
        >
          <SquareTerminal size={18} />
        </button>
        </Tooltip>
        <Tooltip label="Settings" commandId="settings.open">
        <button
          className="activity-bar-icon"
          onClick={() => useCommandsStore.getState().executeCommand('settings.open')}
        >
          <Settings size={18} />
        </button>
        </Tooltip>
      </div>
    </div>
  );
}

export default ActivityBar;
