import { BotMessageSquare, Layers } from 'lucide-react';
import { useUiStore, type RightSidebarView } from '../../../stores/ui';
import { useProjectContextStore } from '../../../stores/project-context';
import Tooltip from '../../../components/Tooltip';

// A bare speech bubble said "chat" but not "AI" — it read as a comments or
// messaging panel. The bot face keeps the bubble silhouette (so the panel is
// still recognisable at a glance) while naming what the chat actually is.
// `commandId` supplies the chord shown in the tooltip. Never spell a chord
// into `label` — it goes stale on a rebinding and is wrong on some platform.
const BASE_ITEMS: Array<{
  id: RightSidebarView;
  icon: typeof BotMessageSquare;
  label: string;
  commandId?: string;
}> = [{ id: 'ai-panel', icon: BotMessageSquare, label: 'AI Assistant', commandId: 'view.aiPanel' }];

function RightActivityBar() {
  const activeView = useUiStore((s) => s.activeRightSidebarView);
  const rightSidebarVisible = useUiStore((s) => s.rightSidebarVisible);
  const isUnityProject = useProjectContextStore((s) => s.isUnityProject);

  const items = isUnityProject
    ? [...BASE_ITEMS, { id: 'unity-inspector' as RightSidebarView, icon: Layers, label: 'Inspector' }]
    : BASE_ITEMS;

  return (
    <div className="activity-bar activity-bar--right">
      {items.map(({ id, icon: Icon, label, commandId }) => (
        <Tooltip key={id} label={label} commandId={commandId} side="left">
        <button
          data-coach={id}
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
        >
          <Icon size={18} />
        </button>
        </Tooltip>
      ))}
    </div>
  );
}

export default RightActivityBar;
