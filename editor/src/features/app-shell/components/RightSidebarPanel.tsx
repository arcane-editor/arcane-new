import { useUiStore } from '../../../stores/ui';
import { useProjectContextStore } from '../../../stores/project-context';
import { AiChatPanel } from '../../ai-panel';
import { SceneUsagePanel } from '../../unity-context';

function RightSidebarPanel() {
  const activeView = useUiStore((s) => s.activeRightSidebarView);
  const aiPanelMaximized = useUiStore((s) => s.aiPanelMaximized);
  const isUnityProject = useProjectContextStore((s) => s.isUnityProject);

  // When the AI panel is maximized it renders inside an overlay portal mounted
  // at the App root; the sidebar slot stays empty so the editor has full width
  // behind the dimmed backdrop. Keeps a single AiChatPanel instance.
  if (aiPanelMaximized) {
    return null;
  }

  switch (activeView) {
    case 'ai-panel':
      return <AiChatPanel />;
    case 'unity-inspector':
      return isUnityProject ? <SceneUsagePanel /> : <AiChatPanel />;
    default:
      return <AiChatPanel />;
  }
}

export default RightSidebarPanel;
