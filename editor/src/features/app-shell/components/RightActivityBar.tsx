import { MessageSquare, Layers } from 'lucide-react';
import { useUiStore, type RightSidebarView } from '../../../stores/ui';
import { useProjectContextStore } from '../../../stores/project-context';

const BASE_ITEMS: Array<{ id: RightSidebarView; icon: typeof MessageSquare; label: string }> = [
  { id: 'ai-panel', icon: MessageSquare, label: 'AI Assistant' },
];

function RightActivityBar() {
  const activeView = useUiStore((s) => s.activeRightSidebarView);
  const rightSidebarVisible = useUiStore((s) => s.rightSidebarVisible);
  const isUnityProject = useProjectContextStore((s) => s.isUnityProject);

  const items = isUnityProject
    ? [...BASE_ITEMS, { id: 'unity-inspector' as RightSidebarView, icon: Layers, label: 'Inspector' }]
    : BASE_ITEMS;

  return (
    <div className="activity-bar activity-bar--right">
      {items.map(({ id, icon: Icon, label }) => (
        <button
          key={id}
          className={`activity-bar-icon${activeView === id && rightSidebarVisible ? ' active' : ''}`}
          onClick={() => {
            const ui = useUiStore.getState();
            if (id === ui.activeRightSidebarView && ui.rightSidebarVisible) {
              ui.setRightSidebarVisible(false);
            } else {
              ui.setActiveRightSidebarView(id);
              ui.setRightSidebarVisible(true);
            }
          }}
          title={label}
        >
          <Icon size={24} />
        </button>
      ))}
    </div>
  );
}

export default RightActivityBar;
