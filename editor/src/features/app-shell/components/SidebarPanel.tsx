import { useUiStore } from '../../../stores/ui';
import { useProjectContextStore } from '../../../stores/project-context';
import { ExplorerPanel } from '../../explorer';
import { SourceControlPanel } from '../../git';
import { SearchOutlinePanel } from '../../search';
import { SceneContextPanel } from '../../unity-context';
import { HierarchyPanel } from '../../unity-hierarchy';
import { TestPanel } from '../../unity-test-runner';
import { DebugPanel } from '../../debugger';
import { InputHubPanel } from '../../unity-input';
import { ScriptableObjectsPanel } from '../../unity-scriptable-objects';
import { UnityUiPanel } from '../../uitoolkit';
import { ErrorBoundary } from '../../../components/ErrorBoundary';

function SidebarPanel() {
  const activeView = useUiStore((s) => s.activeSidebarView);
  const isUnityProject = useProjectContextStore((s) => s.isUnityProject);

  switch (activeView) {
    case 'explorer':
      return <ExplorerPanel />;
    case 'search':
      return <SearchOutlinePanel />;
    case 'source-control':
      return <SourceControlPanel />;
    case 'scene-context':
      return isUnityProject ? <SceneContextPanel /> : <ExplorerPanel />;
    case 'hierarchy':
      return isUnityProject ? (
        <ErrorBoundary fallback={<div className="sidebar-empty">Hierarchy unavailable.</div>}>
          <HierarchyPanel />
        </ErrorBoundary>
      ) : (
        <ExplorerPanel />
      );
    case 'test':
      return isUnityProject ? (
        <ErrorBoundary fallback={<div className="sidebar-empty">Test runner unavailable.</div>}>
          <TestPanel />
        </ErrorBoundary>
      ) : (
        <ExplorerPanel />
      );
    case 'scriptable-objects':
      return isUnityProject ? (
        <ErrorBoundary fallback={<div className="sidebar-empty">ScriptableObjects unavailable.</div>}>
          <ScriptableObjectsPanel />
        </ErrorBoundary>
      ) : (
        <ExplorerPanel />
      );
    case 'input':
      return isUnityProject ? (
        <ErrorBoundary fallback={<div className="sidebar-empty">Input Hub unavailable.</div>}>
          <InputHubPanel />
        </ErrorBoundary>
      ) : (
        <ExplorerPanel />
      );
    case 'unity-ui':
      return isUnityProject ? (
        <ErrorBoundary fallback={<div className="sidebar-empty">Unity UI unavailable.</div>}>
          <UnityUiPanel />
        </ErrorBoundary>
      ) : (
        <ExplorerPanel />
      );
    case 'debug':
      return isUnityProject ? (
        <ErrorBoundary fallback={<div className="dbg-section-empty">Debugger unavailable.</div>}>
          <DebugPanel />
        </ErrorBoundary>
      ) : (
        <ExplorerPanel />
      );
    default:
      return <ExplorerPanel />;
  }
}

export default SidebarPanel;
