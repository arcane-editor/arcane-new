/**
 * Suggestions pinned to a plan document, and the steps that document declares.
 *
 * Notes are anchored on their QUOTED TEXT plus the nearest heading, never on a
 * character offset. Revising a plan means the model rewrites the whole file, so
 * every offset moves; text survives renumbering, reordering and rewording
 * around it. When the text really is gone the note becomes *unanchored* and
 * stays in the list — the user wrote it and it is still the thing they want
 * changed, so dropping it silently would be the worst outcome.
 */

// The shapes live in `types/` so `stores/ai.ts` can hold notes without
// importing this feature's barrel (which exports components that read that
// store — a cycle). The behaviour they describe is documented above.
export type { PlanNote, PlanStep } from '../../../types';

import type { PlanNote, PlanStep } from '../../../types';

let seq = 0;

/** Heading immediately above `index`, or the document's title. */
function headingAbove(doc: string, index: number): string {
  const before = doc.slice(0, index);
  const headings = [...before.matchAll(/^#{1,6}\s+(.+)$/gm)];
  if (headings.length > 0) return headings[headings.length - 1][1].trim();
  const first = doc.match(/^#{1,6}\s+(.+)$/m);
  return first ? first[1].trim() : '';
}

export function createNote(doc: string, quotedText: string, body: string): PlanNote {
  const index = doc.indexOf(quotedText);
  return {
    id: `note_${++seq}`,
    quotedText,
    body,
    headingPath: index === -1 ? headingAbove(doc, 0) : headingAbove(doc, index),
    anchored: index !== -1,
  };
}

/**
 * Re-locate every note against a rewritten document.
 *
 * Returns new objects; the inputs are never mutated, so a caller holding the
 * previous list for a diff still has it.
 */
export function reanchorNotes(notes: PlanNote[], doc: string): PlanNote[] {
  return notes.map((note) => {
    const index = doc.indexOf(note.quotedText);
    if (index === -1) return { ...note, anchored: false };
    return { ...note, anchored: true, headingPath: headingAbove(doc, index) };
  });
}

/**
 * Strips the plan-planning template's (Task 12) `T<n> [easy|hard]` bookkeeping
 * prefix from a checkbox line's captured text, so progress bars / PlanList
 * show just the human-readable title (`T2 [hard] Refactor X` -> `Refactor
 * X`). Display-only: `planStepsOf`'s counting/anchoring above already ran on
 * the raw captured text, so this never changes step counts or which text
 * `createNote`/`reanchorNotes` match against.
 */
function stripTodoPrefix(title: string): string {
  return title.replace(/^T\d+\s+(?:\[(?:easy|hard)\]\s+)?/, '').trim();
}

/**
 * The steps a plan declares, with their completion state.
 *
 * Task-list items win over headings: a plan using `- [ ]` is tracking its own
 * progress, which makes its headings structure rather than steps. Execution
 * marks these off, so this is what the progress bar counts.
 */
export function planStepsOf(doc: string): PlanStep[] {
  const tasks = [...doc.matchAll(/^\s*[-*]\s+\[( |x|X)\]\s+(.+)$/gm)];
  if (tasks.length > 0) {
    return tasks.map((m) => ({
      title: stripTodoPrefix(m[2].trim()),
      done: m[1].toLowerCase() === 'x',
    }));
  }

  // Numbered headings (`## 2. Wire NavMeshAgent`) are the shape the planning
  // prompt asks for. An unnumbered heading is a section, not a step.
  return [...doc.matchAll(/^#{2,6}\s+(\d+[.)]\s+.+)$/gm)].map((m) => ({
    title: m[1].trim(),
    done: false,
  }));
}
