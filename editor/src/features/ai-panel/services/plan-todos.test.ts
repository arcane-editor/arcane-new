import { describe, it, expect } from 'bun:test';
import { parsePlanTodos, planTodosToHostedPlan, type PlanTodo } from './plan-todos';

describe('parsePlanTodos', () => {
  it('parses a strict line: id + difficulty tag + title, unchecked', () => {
    expect(parsePlanTodos('- [ ] T1 [easy] Add CoinPickup component')).toEqual([
      { id: 'T1', title: 'Add CoinPickup component', difficulty: 'easy', done: false },
    ]);
  });

  it('parses a strict line: id + difficulty tag + title, checked', () => {
    expect(parsePlanTodos('- [x] T2 [hard] Refactor NavMeshAgent wiring')).toEqual([
      { id: 'T2', title: 'Refactor NavMeshAgent wiring', difficulty: 'hard', done: true },
    ]);
  });

  it('accepts uppercase X as checked', () => {
    expect(parsePlanTodos('- [X] T1 [easy] Do it')[0].done).toBe(true);
  });

  it('accepts `*` bullets, same as `-`', () => {
    expect(parsePlanTodos('* [ ] T1 [easy] Do it')).toEqual([
      { id: 'T1', title: 'Do it', difficulty: 'easy', done: false },
    ]);
  });

  it('accepts leading indentation before the bullet', () => {
    expect(parsePlanTodos('  - [ ] T1 [easy] Do it')).toEqual([
      { id: 'T1', title: 'Do it', difficulty: 'easy', done: false },
    ]);
  });

  it('parses a tag-less line (no difficultyTags template) as untagged', () => {
    expect(parsePlanTodos('- [ ] T1 Add CoinPickup component')).toEqual([
      { id: 'T1', title: 'Add CoinPickup component', done: false },
    ]);
  });

  it('parses an id-less line (hand-written todo) with no id', () => {
    expect(parsePlanTodos('- [ ] Add CoinPickup component')).toEqual([
      { id: null, title: 'Add CoinPickup component', done: false },
    ]);
  });

  it('parses an id-less but tagged line', () => {
    expect(parsePlanTodos('- [ ] [hard] Add CoinPickup component')).toEqual([
      { id: null, title: 'Add CoinPickup component', difficulty: 'hard', done: false },
    ]);
  });

  it('falls back to loose capture when the bracket contents are malformed junk', () => {
    // "[medium]" isn't a valid difficulty tag, so it isn't stripped out — it
    // stays as part of the title rather than losing the checkbox line entirely.
    const todos = parsePlanTodos('- [ ] T1 [medium] Do the thing');
    expect(todos).toHaveLength(1);
    expect(todos[0]).toEqual({ id: 'T1', title: '[medium] Do the thing', done: false });
  });

  it('falls back to loose capture when the id looks malformed (not T<digits>)', () => {
    const todos = parsePlanTodos('- [ ] Task1 [easy] Do the thing');
    expect(todos).toHaveLength(1);
    expect(todos[0].id).toBeNull();
    expect(todos[0].title).toBe('Task1 [easy] Do the thing');
  });

  it('returns [] for a document with zero checkbox lines', () => {
    expect(parsePlanTodos('# Title\n\nJust prose, no checkboxes here.\n')).toEqual([]);
  });

  it('returns [] for an empty string', () => {
    expect(parsePlanTodos('')).toEqual([]);
  });

  it('never throws on garbage input', () => {
    // @ts-expect-error deliberately passing non-string garbage to prove the
    // resilience contract holds even when a caller's types lie at runtime.
    expect(() => parsePlanTodos(null)).not.toThrow();
    // @ts-expect-error same as above
    expect(parsePlanTodos(undefined)).toEqual([]);
    // @ts-expect-error same as above
    expect(parsePlanTodos(12345)).toEqual([]);
  });

  it('never throws on a huge, adversarial document', () => {
    const huge = '- [ ] '.repeat(5000) + 'x'.repeat(200_000) + '\n' + '- [ ] T1 [hard] real one\n';
    expect(() => parsePlanTodos(huge)).not.toThrow();
    const todos = parsePlanTodos(huge);
    expect(todos.some((t) => t.title === 'real one' && t.difficulty === 'hard')).toBe(true);
  });

  it('finds checkbox lines anywhere in the document, without requiring a ## Todos heading', () => {
    const doc = '# Some Plan\n\nSome prose.\n\n- [ ] T1 [easy] A todo with no heading above it\n';
    expect(parsePlanTodos(doc)).toEqual([
      { id: 'T1', title: 'A todo with no heading above it', difficulty: 'easy', done: false },
    ]);
  });

  it('round-trips the plan-planning template example', () => {
    const doc = `# Add Enemy AI

## Goal
Give enemies chase behaviour.

## Context
EnemyController.cs does not exist yet; follow the pattern in PlayerController.cs.

## Todos
- [ ] T1 [easy] Create EnemyController.cs
- [ ] T2 [hard] Wire NavMeshAgent

## Guide

### T1: Create EnemyController.cs
Add a MonoBehaviour under Assets/Scripts.

### T2: Wire NavMeshAgent
Set the agent's destination each frame toward the player target.

## Risks
- Pathfinding may stall on unbaked navmesh.
`;
    expect(parsePlanTodos(doc)).toEqual([
      { id: 'T1', title: 'Create EnemyController.cs', difficulty: 'easy', done: false },
      { id: 'T2', title: 'Wire NavMeshAgent', difficulty: 'hard', done: false },
    ]);
  });

  it('reads a mix of checked/unchecked, tagged/untagged lines from one document', () => {
    const doc = `## Todos
- [x] T1 [easy] Already done
- [ ] T2 [hard] Still to do
- [ ] T3 Untagged todo
`;
    expect(parsePlanTodos(doc)).toEqual([
      { id: 'T1', title: 'Already done', difficulty: 'easy', done: true },
      { id: 'T2', title: 'Still to do', difficulty: 'hard', done: false },
      { id: 'T3', title: 'Untagged todo', done: false },
    ]);
  });
});

describe('planTodosToHostedPlan', () => {
  it('maps a tagged, unfinished todo to a pending HostedPlanEntry carrying its difficulty', () => {
    const todos: PlanTodo[] = [{ id: 'T1', title: 'Add CoinPickup', difficulty: 'hard', done: false }];
    expect(planTodosToHostedPlan(todos)).toEqual([
      { text: 'Add CoinPickup', status: 'pending', difficulty: 'hard' },
    ]);
  });

  it('maps a checked todo to a done HostedPlanEntry', () => {
    const todos: PlanTodo[] = [{ id: 'T1', title: 'Add CoinPickup', difficulty: 'easy', done: true }];
    expect(planTodosToHostedPlan(todos)).toEqual([
      { text: 'Add CoinPickup', status: 'done', difficulty: 'easy' },
    ]);
  });

  it('maps an untagged todo to an entry with an undefined difficulty', () => {
    const todos: PlanTodo[] = [{ id: 'T1', title: 'Add CoinPickup', done: false }];
    const mapped = planTodosToHostedPlan(todos);
    expect(mapped).toEqual([{ text: 'Add CoinPickup', status: 'pending', difficulty: undefined }]);
    expect(mapped[0].difficulty).toBeUndefined();
  });

  it('maps a whole tagged plan, preserving order', () => {
    const todos: PlanTodo[] = [
      { id: 'T1', title: 'Already done', difficulty: 'easy', done: true },
      { id: 'T2', title: 'Still to do', difficulty: 'hard', done: false },
    ];
    expect(planTodosToHostedPlan(todos)).toEqual([
      { text: 'Already done', status: 'done', difficulty: 'easy' },
      { text: 'Still to do', status: 'pending', difficulty: 'hard' },
    ]);
  });

  it('returns [] for an empty todo list', () => {
    expect(planTodosToHostedPlan([])).toEqual([]);
  });
});
