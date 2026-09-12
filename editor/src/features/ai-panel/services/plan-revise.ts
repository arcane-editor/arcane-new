/**
 * Prompt builder for plan revision (PlanDocumentView's pinned suggestions).
 *
 * plan-planning's toolset is read-only BY DESIGN — the model cannot write the
 * plan file, so the prompt must ask for the full revised plan as the REPLY
 * text; plan-controller persists it (the same division of labor startPlanning
 * uses for the initial draft). The old prompt ordered the model to "write the
 * full revised plan back to that file", which it could only ever fail or
 * apologize at — every pinned note was silently discarded and Execute re-ran
 * the unrevised plan.
 *
 * Each note is presented as its quoted text under the heading it was pinned
 * to, so the model knows exactly which part of its own plan is being
 * questioned — that targeting is the whole reason notes are anchored rather
 * than collected as free text. Notes whose text no longer appears (the plan
 * moved on) are still sent, but marked, so the model treats them as general
 * feedback rather than hunting for a passage that is gone.
 *
 * Type-only import from the markdown-preview barrel (erased at compile time)
 * keeps this module Bun-testable.
 */
import type { PlanNote } from '../../markdown-preview';

export function buildReviseNotesPrompt(
  planPath: string,
  planContent: string,
  notes: PlanNote[],
  /**
   * What the user typed in the composer, when the revision came from there
   * rather than from the Revise button. Feedback about the plan as a whole has
   * no passage to pin itself to, so it is stated separately instead of being
   * forced through the anchored-note shape.
   */
  freeText?: string,
): string {
  const body = notes
    .map((n, i) => {
      const where = n.anchored
        ? `under "${n.headingPath}"`
        : `under "${n.headingPath}" (this text is no longer in the plan — treat as general feedback)`;
      return `${i + 1}. ${where}\n   > ${n.quotedText}\n   ${n.body}`;
    })
    .join('\n\n');

  const typed = freeText?.trim();
  const sections = [
    ...(typed ? [`Feedback on the plan as a whole:\n${typed}`] : []),
    ...(notes.length > 0 ? [`Suggestions pinned to specific passages:\n${body}`] : []),
  ].join('\n\n');

  return (
    `Revise the plan below to address the feedback. Reply with the FULL ` +
    `revised plan in the same markdown format — your reply becomes the new ` +
    `content of ${planPath}, so include every part of the plan (updated), ` +
    `with no commentary before or after it. Leave already-checked \`- [x]\` todos ` +
    `checked, and carry forward each kept todo's \`T<n>\` id and \`[easy]\`/\`[hard]\` ` +
    `difficulty tag unchanged.\n\n` +
    `${sections}\n\n--- Current plan (${planPath}) ---\n${planContent}`
  );
}
