/**
 * PlanList — renders Arcane's live in-loop plan/TODO checklist, populated by
 * the `todo_update` tool (P3.5, `arcanePlan`).
 *
 * Distinct from PlanActions (the Arcane markdown-plan workflow).
 */

import { Circle, CircleDot, CheckCircle2 } from 'lucide-react';
import { useAiStore } from '../../../stores/ai';

type NormalizedStatus = 'pending' | 'in_progress' | 'completed';

interface PlanEntry {
  text: string;
  status: NormalizedStatus;
}

function PlanList() {
  const arcanePlan = useAiStore((s) => s.arcanePlan);

  const entries: PlanEntry[] = (arcanePlan ?? []).map((e) => ({
    text: e.text,
    status: e.status === 'done' ? 'completed' : e.status,
  }));

  if (entries.length === 0) return null;

  return (
    <div className="ai-plan-list">
      <div className="ai-plan-list-header">Plan</div>
      {entries.map((entry, i) => (
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
          <span className="ai-plan-text">{entry.text}</span>
        </div>
      ))}
    </div>
  );
}

export default PlanList;
