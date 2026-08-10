import { describe, it, expect } from 'bun:test';
import { createNote, reanchorNotes, planStepsOf, type PlanNote } from './note-anchor';

/**
 * The real shape a plan takes — see `prompts/plan-planning.ts`, which asks for
 * `## Steps` followed by `- [ ] **Step N: …**`, and `plan-execution.ts`, which
 * flips each to `- [x]` as it completes them.
 */
const DOC = `# Add Enemy AI

## Goal
Give enemies chase behaviour.

## Steps
- [ ] **Step 1: Create EnemyController.cs** — Add a MonoBehaviour under Assets/Scripts.
- [ ] **Step 2: Wire NavMeshAgent** — Set transform.position each frame toward the player target.
- [ ] **Step 3: Add patrol waypoints** — Define the route.

## Risks
Pathfinding may stall on unbaked navmesh.
`;

describe('createNote', () => {
  it('captures the quoted text and the heading it sits under', () => {
    const note = createNote(DOC, 'transform.position', 'use SetDestination instead');
    expect(note.quotedText).toBe('transform.position');
    expect(note.headingPath).toBe('Steps');
    expect(note.body).toBe('use SetDestination instead');
    expect(note.anchored).toBe(true);
  });

  it('falls back to the document title when the text is above any heading', () => {
    const note = createNote(DOC, 'Add Enemy AI', 'rename this');
    expect(note.headingPath).toBe('Add Enemy AI');
  });

  it('marks a note whose text is not in the document as unanchored', () => {
    expect(createNote(DOC, 'nowhere at all', 'hm').anchored).toBe(false);
  });
});

describe('reanchorNotes', () => {
  /**
   * The AI rewrites the whole plan on revise, so character offsets are
   * guaranteed to move. Anchoring on the quoted text means a note survives its
   * step being renumbered, reordered, or reworded around it.
   */
  it('keeps a note anchored when its text moves', () => {
    const note = createNote(DOC, 'transform.position', 'use SetDestination');
    // The model reordered the steps and moved the quoted text under a
    // different heading; the note must follow it.
    const rewritten = DOC.replace('## Risks', '## Revised Steps').replace(
      '- [ ] **Step 2: Wire NavMeshAgent** — Set transform.position each frame toward the player target.',
      '',
    ) + '\n## Revised Steps\nSet transform.position each frame toward the player target.\n';
    const [out] = reanchorNotes([note], rewritten);
    expect(out.anchored).toBe(true);
    expect(out.headingPath).toBe('Revised Steps');
  });

  /**
   * Losing a user's note silently is worse than showing it without a
   * highlight — they wrote it, and it is still the thing they want changed.
   */
  it('keeps an unanchorable note in the list rather than dropping it', () => {
    const note = createNote(DOC, 'transform.position', 'use SetDestination');
    const rewritten = DOC.replace('transform.position', 'agent.SetDestination(target)');
    const [out] = reanchorNotes([note], rewritten);
    expect(out.anchored).toBe(false);
    expect(out.body).toBe('use SetDestination');
    expect(out.quotedText).toBe('transform.position');
  });

  it('returns an empty list unchanged', () => {
    expect(reanchorNotes([], DOC)).toEqual([]);
  });

  it('does not mutate the notes it is given', () => {
    const note = createNote(DOC, 'transform.position', 'x');
    const before: PlanNote = { ...note };
    reanchorNotes([note], 'completely different');
    expect(note).toEqual(before);
  });
});

describe('planStepsOf', () => {
  it('reads the plan-prompt task items as steps', () => {
    expect(planStepsOf(DOC).map((s) => s.title)).toEqual([
      '**Step 1: Create EnemyController.cs** — Add a MonoBehaviour under Assets/Scripts.',
      '**Step 2: Wire NavMeshAgent** — Set transform.position each frame toward the player target.',
      '**Step 3: Add patrol waypoints** — Define the route.',
    ]);
  });

  it('reads a checked task item as done', () => {
    const steps = planStepsOf('- [ ] first\n- [x] second\n');
    expect(steps.map((s) => ({ t: s.title, d: s.done }))).toEqual([
      { t: 'first', d: false },
      { t: 'second', d: true },
    ]);
  });

  it('tracks completion as the executor flips boxes', () => {
    // plan-execution.ts edits the file, changing `- [ ]` to `- [x]` per step.
    const midRun = DOC.replace('- [ ] **Step 1:', '- [x] **Step 1:');
    expect(planStepsOf(midRun).map((s) => s.done)).toEqual([true, false, false]);
  });

  it('falls back to numbered headings for a hand-written plan', () => {
    // Not the prompt's format, but a plan a user wrote themselves should
    // still show progress rather than nothing.
    const handWritten = '# Thing\n\n## 1. First\n\n## 2. Second\n';
    expect(planStepsOf(handWritten).map((s) => s.title)).toEqual(['1. First', '2. Second']);
  });

  it('returns nothing for a document with no steps', () => {
    expect(planStepsOf('Just a paragraph.')).toEqual([]);
  });
});
