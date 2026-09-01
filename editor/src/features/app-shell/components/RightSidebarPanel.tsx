import { useUiStore } from '../../../stores/ui';
import { useProjectContextStore } from '../../../stores/project-context';
import { AiChatPanel } from '../../ai-panel';
import { UnityInspectorPanel } from '../../unity-scriptable-objects';
import { ErrorBoundary } from '../../../components/ErrorBoundary';

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

  // Local boundary, same pattern as the left SidebarPanel's per-panel
  // boundaries: without it a panel crash bubbles to the ROOT boundary and
  // replaces the entire editor with the crash card.
  const aiPanel = (
    <ErrorBoundary
      fallback={<div className="sidebar-empty">AI panel crashed — close and reopen it to retry.</div>}
    >
      <AiChatPanel />
    </ErrorBoundary>
  );

  switch (activeView) {
    case 'ai-panel':
      return aiPanel;
    case 'unity-inspector':
      return isUnityProject ? (
        <ErrorBoundary fallback={<div className="sidebar-empty">Inspector unavailable.</div>}>
          <UnityInspectorPanel />
        </ErrorBoundary>
      ) : (
        aiPanel
      );
    default:
      return aiPanel;
  }
}

export default RightSidebarPanel;
