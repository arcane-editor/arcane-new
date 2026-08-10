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

export interface PlanNote {
  id: string;
  /** The exact text the user selected. */
  quotedText: string;
  /** What they want changed. */
  body: string;
  /** Nearest preceding heading, or the document title. */
  headingPath: string;
  /** False once the quoted text no longer appears in the document. */
  anchored: boolean;
}

export interface PlanStep {
  title: string;
  done: boolean;
}

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
 * The steps a plan declares, with their completion state.
 *
 * Task-list items win over headings: a plan using `- [ ]` is tracking its own
 * progress, which makes its headings structure rather than steps. Execution
 * marks these off, so this is what the progress bar counts.
 */
export function planStepsOf(doc: string): PlanStep[] {
  const tasks = [...doc.matchAll(/^\s*[-*]\s+\[( |x|X)\]\s+(.+)$/gm)];
  if (tasks.length > 0) {
    return tasks.map((m) => ({ title: m[2].trim(), done: m[1].toLowerCase() === 'x' }));
  }

  // Numbered headings (`## 2. Wire NavMeshAgent`) are the shape the planning
  // prompt asks for. An unnumbered heading is a section, not a step.
  return [...doc.matchAll(/^#{2,6}\s+(\d+[.)]\s+.+)$/gm)].map((m) => ({
    title: m[1].trim(),
    done: false,
  }));
}
