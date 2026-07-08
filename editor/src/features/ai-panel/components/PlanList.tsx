/**
 * PlanList — renders the active agent's live plan/TODO checklist. Generalized
 * (P3.5) from the Claude-only `ClaudePlanList` to also cover Arcane's own
 * in-loop `todo_update` tool: reads `claudePlan` (ACP `plan` update) when the
 * Claude agent is selected, or `arcanePlan` (todo_update tool calls) when the
 * Arcane agent is selected — i.e. whichever store field the ACTIVE agent
 * populates. Gating on `selectedAgent` (rather than "whichever is non-null")
 * matters because switching agents doesn't clear the other's plan state, so a
 * stale Claude plan could otherwise linger onscreen while chatting with
 * Arcane, or vice versa.
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
  const claudePlan = useAiStore((s) => s.claudePlan);
  const arcanePlan = useAiStore((s) => s.arcanePlan);
  const selectedAgent = useAiStore((s) => s.selectedAgent);

  const entries: PlanEntry[] =
    selectedAgent === 'claude'
      ? claudePlan.map((e) => ({ text: e.content, status: e.status }))
      : (arcanePlan ?? []).map((e) => ({
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
