/**
 * PlanList — renders Arcane's live in-loop plan/TODO checklist, populated by
 * the `todo_update` tool (P3.5, `arcanePlan`).
 *
 * Distinct from PlanActions (the Arcane markdown-plan workflow).
 *
 * T9: mounted in `AiChatPanel.tsx` (sticky, between the message list and the
 * composer) rather than inline at the bottom of `MessageList`, since the
 * plan now lives for the whole session instead of resetting every send.
 * Header is a collapse toggle showing live "done/total" counts; default
 * expanded, no auto-collapse.
 */

import { useState } from 'react';
import { Circle, CircleDot, CheckCircle2, ChevronRight, ChevronDown } from 'lucide-react';
import { useAiStore } from '../../../stores/ai';

type NormalizedStatus = 'pending' | 'in_progress' | 'completed';

interface PlanEntry {
  text: string;
  status: NormalizedStatus;
}

function PlanList() {
  const arcanePlan = useAiStore((s) => s.arcanePlan);
  const [collapsed, setCollapsed] = useState(false);

  const entries: PlanEntry[] = (arcanePlan ?? []).map((e) => ({
    text: e.text,
    status: e.status === 'done' ? 'completed' : e.status,
  }));

  if (entries.length === 0) return null;

  const doneCount = entries.filter((e) => e.status === 'completed').length;

  return (
    <div className="ai-plan-list">
      <button
        type="button"
        className="ai-plan-list-header"
        onClick={() => setCollapsed((v) => !v)}
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <span>
          Plan ({doneCount}/{entries.length} done)
        </span>
      </button>
      {!collapsed && (
        <div className="ai-plan-list-items">
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
      )}
    </div>
  );
}

export default PlanList;
