// Pure routing decision for a message typed into the composer while the AI
// panel is in plan mode. Separate from plan-controller.ts (which imports
// stores and is not Bun-importable) so the decision itself stays tested.
//
// 'resume'  → continue executing the active plan, treating the user's text as
//             guidance (plan-execution prompt, full tool set).
// 'plan'    → start a fresh planning run (plan-planning prompt, read-only tools).
//
// 'executing' also resumes: with a live run the composer is disabled anyway,
// so reaching this with 'executing' means the phase is STUCK from a send that
// rejected before its finally — recovery, not conflict. Regenerate/Revise
// remain the explicit re-plan paths.

import type { PlanPhase } from '../../../stores/ai';

export function routePlanSend(
  phase: PlanPhase,
  activePlanPath: string | null,
): 'resume' | 'plan' {
  if (!activePlanPath) return 'plan';
  return phase === 'awaiting-execute' || phase === 'executing' ? 'resume' : 'plan';
}
