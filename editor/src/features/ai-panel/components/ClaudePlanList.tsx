/**
 * ClaudePlanList — renders Claude's streamed TODO/plan checklist (ACP `plan`
 * update). Distinct from PlanActions (the Arcane markdown-plan workflow).
 * Renders only for the Claude agent when a plan is present.
 */

import { Circle, CircleDot, CheckCircle2 } from 'lucide-react';
import { useAiStore } from '../../../stores/ai';

function ClaudePlanList() {
  const plan = useAiStore((s) => s.claudePlan);
  const selectedAgent = useAiStore((s) => s.selectedAgent);

  if (selectedAgent !== 'claude' || plan.length === 0) return null;

  return (
    <div className="ai-plan-list">
      <div className="ai-plan-list-header">Plan</div>
      {plan.map((entry, i) => (
        <div key={i} className={`ai-plan-item ai-plan-${entry.status}`}>
          <span className="ai-plan-icon">
            {entry.status === 'completed' ? (
              <CheckCircle2 size={13} />
            ) : entry.status === 'in_progress' ? (
              <CircleDot size={13} />
            ) : (
              <Circle size={13} />
            )}
          </span>
          <span className="ai-plan-text">{entry.content}</span>
        </div>
      ))}
    </div>
  );
}

export default ClaudePlanList;
