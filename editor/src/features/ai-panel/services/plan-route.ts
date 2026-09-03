// Pure routing decision for a message typed into the composer while the AI
// panel is in plan mode. Separate from plan-controller.ts (which imports
// stores and is not Bun-importable) so the decision itself stays tested.
//
// 'revise'  → fold the user's text into the plan and rewrite it
//             (plan-planning prompt, read-only tools). Nothing is built.
// 'resume'  → continue executing the active plan, treating the user's text as
//             guidance (plan-execution prompt, full tool set).
// 'plan'    → start a fresh planning run (plan-planning prompt, read-only tools).
//
// A plan that is written but NOT yet started revises. It used to resume, which
// meant the obvious way to comment on a plan you were still reading — type a
// sentence — silently handed the model the write tools and began building the
// thing you were still editing. Execution is what the Execute button is for;
// with a plan on screen and nothing running, the composer is for talking about
// it. This matches how the plan document already treats typed feedback (select
// text → suggest → Revise) and how Cursor's plan mode refines "through chat or
// markdown files".
//
// 'executing' still resumes: with a live run the composer is disabled anyway,
// so reaching this with 'executing' means the phase is STUCK from a send that
// rejected before its finally — recovery, not conflict.
//
// 'interrupted' resumes too, and is the phase this actually matters for: a
// run that hit the turn cap, was aborted, or errored out ends up here
// (`mode-transition.ts`'s `normalizeLivePlanState`, `plan-run.ts`), and the
// wrap-up text told the user to reply "continue" to pick it back up. Routing
// it anywhere but 'resume' would make that promise false — the composer
// would silently re-plan (stripping the write tools) instead of continuing
// the plan the model just told the user it stopped mid-way through.

import type { PlanPhase } from '../../../stores/ai';

export function routePlanSend(
  phase: PlanPhase,
  activePlanPath: string | null,
): 'revise' | 'resume' | 'plan' {
  if (!activePlanPath) return 'plan';
  if (phase === 'awaiting-execute') return 'revise';
  return phase === 'executing' || phase === 'interrupted' ? 'resume' : 'plan';
}
