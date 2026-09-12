/**
 * PlanActions — buttons shown after the planning-phase assistant message.
 * Execute/Resume/Run again + Regenerate + Open Plan. Wired to planController.
 *
 * Visibility: rendered by MessageList when planPhase is 'awaiting-execute',
 * 'interrupted' or 'completed' and there's an activePlanPath.
 *
 * The primary button reads the phase rather than assuming a plan on screen is
 * one that has never run. A finished run used to land back on
 * 'awaiting-execute' (see `plan-run.ts`'s `resolvePostExecutionPhase`), so
 * this card re-offered "Execute" for work it had just finished — identical to
 * a plan the user had not started. `completed` is what makes the two
 * distinguishable here.
 */

import { Play, RotateCcw, RotateCw, FileText, Check } from 'lucide-react';
import { useAiStore } from '../../../stores/ai';
import { planController } from '../services/plan-controller';

function PlanActions() {
  const activePlanPath = useAiStore((s) => s.activePlanPath);
  const planPhase = useAiStore((s) => s.planPhase);
  const isAgentRunning = useAiStore((s) => s.isAgentRunning);

  if (!activePlanPath) return null;

  const interrupted = planPhase === 'interrupted';
  const completed = planPhase === 'completed';

  function handlePrimary() {
    if (!activePlanPath) return;
    if (interrupted) {
      planController.resumeExecution('Continue executing the remaining steps.');
      return;
    }
    // 'completed' re-runs the same file from the top — the plan is right
    // there to edit first, and its own `[x]` ticks tell the model what is
    // already done.
    planController.executePlan(activePlanPath);
  }

  function handleRegenerate() {
    planController.regenerate();
  }

  function handleOpen() {
    if (!activePlanPath) return;
    planController.openPlanTab(activePlanPath);
  }

  const planName = activePlanPath.split('/').pop() ?? 'plan.aplan';

  const primaryLabel = interrupted ? 'Resume' : completed ? 'Run again' : 'Execute';
  const primaryTitle = interrupted
    ? 'Resume the plan from where it stopped'
    : completed
      ? 'Run this plan again from the top'
      : 'Execute the plan step by step';

  return (
    <div className={`ai-panel-plan-actions${completed ? ' is-completed' : ''}`}>
      <div className="ai-panel-plan-actions-header">
        <FileText size={12} />
        <span className="ai-panel-plan-actions-name">{planName}</span>
      </div>
      {/* Nothing is pending on a finished plan, so say so instead of leaving
          the buttons to imply there is work left. */}
      {completed && (
        <div className="ai-panel-plan-actions-status">
          <Check size={11} />
          Completed
        </div>
      )}
      <div className="ai-panel-plan-actions-buttons">
        <button
          type="button"
          className={`ai-panel-plan-action${completed ? '' : ' ai-panel-plan-action--primary'}`}
          onClick={handlePrimary}
          disabled={isAgentRunning}
          title={primaryTitle}
        >
          {completed ? <RotateCw size={12} /> : <Play size={12} />}
          {primaryLabel}
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
