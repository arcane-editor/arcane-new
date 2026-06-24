/**
 * PlanActions — buttons shown after the planning-phase assistant message.
 * Execute / Regenerate / Open Plan. Wired to planController.
 *
 * Visibility: rendered by MessageList when planPhase === 'awaiting-execute'
 * and there's an activePlanPath.
 */

import { Play, RotateCcw, FileText } from 'lucide-react';
import { useAiStore } from '../../../stores/ai';
import { planController } from '../services/plan-controller';

function PlanActions() {
  const activePlanPath = useAiStore((s) => s.activePlanPath);
  const isAgentRunning = useAiStore((s) => s.isAgentRunning);

  if (!activePlanPath) return null;

  function handleExecute() {
    if (!activePlanPath) return;
    planController.executePlan(activePlanPath);
  }

  function handleRegenerate() {
    planController.regenerate();
  }

  function handleOpen() {
    if (!activePlanPath) return;
    planController.openPlanTab(activePlanPath);
  }

  const planName = activePlanPath.split('/').pop() ?? 'plan.md';

  return (
    <div className="ai-panel-plan-actions">
      <div className="ai-panel-plan-actions-header">
        <FileText size={12} />
        <span className="ai-panel-plan-actions-name">{planName}</span>
      </div>
      <div className="ai-panel-plan-actions-buttons">
        <button
          type="button"
          className="ai-panel-plan-action ai-panel-plan-action--primary"
          onClick={handleExecute}
          disabled={isAgentRunning}
          title="Execute the plan step by step"
        >
          <Play size={12} />
          Execute
        </button>
        <button
          type="button"
          className="ai-panel-plan-action"
          onClick={handleRegenerate}
          disabled={isAgentRunning}
          title="Regenerate the plan from the original prompt"
        >
          <RotateCcw size={12} />
          Regenerate
        </button>
        <button
          type="button"
          className="ai-panel-plan-action"
          onClick={handleOpen}
          title="Open the plan file in the editor"
        >
          <FileText size={12} />
          Open
        </button>
      </div>
    </div>
  );
}

export default PlanActions;
