import { describe, it, expect } from 'bun:test';
import { insertTodoAfter, removeTodoAt, moveTodo, todoCount } from './todo-edit';

// A plan in the shape `prompts/plan-planning.ts` asks for: a `## Todos`
// checklist whose `T<n>` ids are matched by `### T<n>` entries under
// `## Guide`. Both halves are keyed on that id — `plan-todos.ts` parses the
// checkboxes and `plan-execution.ts` tells the model to read the matching
// guide entry — so any edit that changes the ORDER or the COUNT has to
// renumber both halves together or the plan silently comes apart.
const PLAN = `# Add a character controller

## Goal
Walk, jump, stairs.

## Todos
- [x] T1 [easy] Create the capsule prefab
- [ ] T2 [hard] Write PlayerController.cs
- [ ] T3 Wire up the input actions

## Guide

### T1: Create the capsule prefab
Make a capsule at Assets/Prefabs/Player.prefab.

### T2: Write PlayerController.cs
Use CharacterController.Move and set stepOffset.

### T3: Wire up the input actions
Bind Move and Jump.

## Risks
- Stairs may need a larger stepOffset.
`;

const todoLines = (s: string) => s.split('\n').filter((l) => /^\s*[-*]\s+\[[ xX]\]/.test(l));
const guideHeads = (s: string) => s.split('\n').filter((l) => /^###\s+T\d+/.test(l));

describe('todoCount', () => {
  it('counts the checkbox lines', () => {
    expect(todoCount(PLAN)).toBe(3);
  });
});

describe('removeTodoAt', () => {
  it('drops the checkbox line and its guide entry together', () => {
    const out = removeTodoAt(PLAN, 1);
    expect(todoCount(out)).toBe(2);
    expect(out).not.toContain('Write PlayerController.cs');
    expect(out).not.toContain('CharacterController.Move and set stepOffset');
  });

  it('renumbers what is left so the ids stay sequential and matched', () => {
    const out = removeTodoAt(PLAN, 0);
    expect(todoLines(out)).toEqual([
      '- [ ] T1 [hard] Write PlayerController.cs',
      '- [ ] T2 Wire up the input actions',
    ]);
    expect(guideHeads(out)).toEqual([
      '### T1: Write PlayerController.cs',
      '### T2: Wire up the input actions',
    ]);
  });

  it('keeps everything that is not a todo untouched', () => {
    const out = removeTodoAt(PLAN, 2);
    expect(out).toContain('# Add a character controller');
    expect(out).toContain('## Risks\n- Stairs may need a larger stepOffset.');
  });

  it('is a no-op for an index that is not there', () => {
    expect(removeTodoAt(PLAN, 9)).toBe(PLAN);
    expect(removeTodoAt(PLAN, -1)).toBe(PLAN);
  });
});

describe('insertTodoAfter', () => {
  it('adds a checkbox and a matching guide stub', () => {
    const out = insertTodoAfter(PLAN, 0, 'Bake the NavMesh');
    expect(todoCount(out)).toBe(4);
    expect(out).toContain('- [ ] T2 Bake the NavMesh');
    expect(out).toContain('### T2: Bake the NavMesh');
  });

  it('pushes the ids after it up, in both halves', () => {
    const out = insertTodoAfter(PLAN, 0, 'Bake the NavMesh');
    expect(todoLines(out)).toEqual([
      '- [x] T1 [easy] Create the capsule prefab',
      '- [ ] T2 Bake the NavMesh',
      '- [ ] T3 [hard] Write PlayerController.cs',
      '- [ ] T4 Wire up the input actions',
    ]);
    expect(guideHeads(out)).toEqual([
      '### T1: Create the capsule prefab',
      '### T2: Bake the NavMesh',
      '### T3: Write PlayerController.cs',
      '### T4: Wire up the input actions',
    ]);
  });

  it('inserts at the top for index -1', () => {
    const out = insertTodoAfter(PLAN, -1, 'First');
    expect(todoLines(out)[0]).toBe('- [ ] T1 First');
    expect(guideHeads(out)[0]).toBe('### T1: First');
  });

  it('starts a new todo unchecked and untagged even after a done one', () => {
    const out = insertTodoAfter(PLAN, 0, 'Bake the NavMesh');
    expect(out).toContain('- [ ] T2 Bake the NavMesh');
    expect(out).not.toContain('- [x] T2');
  });
});

describe('moveTodo', () => {
  it('reorders the checklist and the guide the same way', () => {
    const out = moveTodo(PLAN, 2, 0);
    expect(todoLines(out)).toEqual([
      '- [ ] T1 Wire up the input actions',
      '- [x] T2 [easy] Create the capsule prefab',
      '- [ ] T3 [hard] Write PlayerController.cs',
    ]);
    expect(guideHeads(out)).toEqual([
      '### T1: Wire up the input actions',
      '### T2: Create the capsule prefab',
      '### T3: Write PlayerController.cs',
    ]);
  });

  it('carries each todo’s own guide body with it, not just the heading', () => {
    const out = moveTodo(PLAN, 2, 0);
    const guide = out.slice(out.indexOf('## Guide'));
    expect(guide.indexOf('Bind Move and Jump.')).toBeLessThan(
      guide.indexOf('Make a capsule at'),
    );
  });

  it('preserves done state and difficulty tags across the move', () => {
    const out = moveTodo(PLAN, 0, 2);
    expect(out).toContain('[easy] Create the capsule prefab');
    expect(out).toMatch(/- \[x\] T3 \[easy\] Create the capsule prefab/);
  });

  it('is a no-op when the move goes nowhere or out of range', () => {
    expect(moveTodo(PLAN, 1, 1)).toBe(PLAN);
    expect(moveTodo(PLAN, 0, 9)).toBe(PLAN);
    expect(moveTodo(PLAN, -1, 0)).toBe(PLAN);
  });
});

describe('documents that do not match the template', () => {
  // The parser these edits sit beside is deliberately forgiving (see
  // `plan-todos.ts`'s resilience contract) because plans are hand-edited
  // files. These edits have to be too: the worst outcome is corrupting a
  // document someone wrote, so anything unrecognised is left exactly alone.
  const NO_GUIDE = `## Todos\n- [ ] T1 One\n- [ ] T2 Two\n`;

  it('edits the checklist even when there is no Guide section', () => {
    const out = removeTodoAt(NO_GUIDE, 0);
    expect(out).toBe('## Todos\n- [ ] T1 Two\n');
  });

  it('leaves a guide entry that no todo claims alone', () => {
    const orphaned = `## Todos\n- [ ] T1 One\n\n## Guide\n\n### T1: One\na\n\n### T7: Ghost\nb\n`;
    expect(removeTodoAt(orphaned, 0)).toContain('### T7: Ghost');
  });

  it('handles ids the template never produced without inventing them', () => {
    const loose = `## Todos\n- [ ] no id here\n- [ ] T2 has one\n`;
    const out = removeTodoAt(loose, 0);
    expect(out).toBe('## Todos\n- [ ] T1 has one\n');
  });

  it('returns the input unchanged when there are no todos at all', () => {
    const prose = '# Title\n\nJust words.\n';
    expect(removeTodoAt(prose, 0)).toBe(prose);
    expect(moveTodo(prose, 0, 1)).toBe(prose);
    expect(todoCount(prose)).toBe(0);
  });

  it('accepts `*` bullets the way the parser does', () => {
    const star = `## Todos\n* [ ] T1 One\n* [ ] T2 Two\n`;
    expect(todoCount(star)).toBe(2);
    expect(removeTodoAt(star, 0)).toBe('## Todos\n* [ ] T1 Two\n');
  });

  // CRLF: these edits see no todos in a `\r\n` document, and that is the
  // CORRECT behaviour here rather than a gap worth closing locally.
  //
  // `.` excludes `\r` in a JS regex, so `(.*)$` cannot match a line ending in
  // one. `plan-document.ts`'s CHECKBOX_LINE and `plan-todos.ts`'s both end the
  // same way, so a CRLF plan already parses as zero todos everywhere in the
  // app. That matters more than it looks: `PlanDocumentView` derives the index
  // it passes here from `plan-document.ts`'s step list, so if this module
  // alone learned to read CRLF, the two would be counting different things and
  // "delete step 2" could delete something else. Leaving the document
  // untouched is the safe half of that mismatch.
  //
  // Teaching all three parsers `\r` is a worthwhile separate change; doing it
  // to one of them is not.
  it('leaves a CRLF document alone, exactly as the other plan parsers do', () => {
    const crlf = '## Todos\r\n- [ ] T1 One\r\n- [ ] T2 Two\r\n';
    expect(todoCount(crlf)).toBe(0);
    expect(removeTodoAt(crlf, 0)).toBe(crlf);
    expect(moveTodo(crlf, 0, 1)).toBe(crlf);
  });
});
