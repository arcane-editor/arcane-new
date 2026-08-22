// Pure builder for the regenerate-planning send. Separate from
// plan-controller.ts (store-heavy, not Bun-importable) so the one piece of
// logic — how the previous plan's progress is presented to the planner — stays
// tested. Mirrors the plan-route.ts pattern.
//
// Why this exists: Regenerate used to send only the original prompt, so the
// planner drafted blind to the half-executed previous plan. The template
// then produced every step unchecked, and executing the new plan reset all
// previously-done todos to pending — one Regenerate wiped visible progress.

export interface PriorPlan {
  path: string;
  /** Current file content — its `- [x]` marks are the progress record. */
  content: string;
}

/**
 * The text actually SENT for a regenerate. The plan file's name/title and
 * `pendingPrompt` keep using the original prompt (see plan-controller.ts) —
 * only the send text carries the prior-plan context.
 */
export function buildRegeneratePrompt(originalPrompt: string, priorPlan: PriorPlan | null): string {
  if (!priorPlan) return originalPrompt;
  return (
    `${originalPrompt}\n\n` +
    `## Previous plan (${priorPlan.path}) — its progress marks are authoritative\n\n` +
    `${priorPlan.content}\n\n` +
    `Re-plan the remaining work. Carry every todo already checked \`- [x]\` above into the new plan ` +
    `pre-checked \`- [x]\` (keep its \`T<n>\` id and title, summarized), and break down only the unfinished ` +
    `work into new todos. Do not reset completed work to unchecked, and carry forward each kept todo's ` +
    `\`[easy]\`/\`[hard]\` difficulty tag unchanged.`
  );
}
