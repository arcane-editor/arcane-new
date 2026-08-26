/**
 * Pure parser for the plan-planning template's `## Todos` checklist (Task 12,
 * `prompts/plan-planning.ts`). Lines look like `- [ ] T1 [easy] <title>`
 * (difficulty tag only present when the template requested one — high tier
 * only, see `difficultyTags` in `prompts/index.ts`).
 *
 * RESILIENCE CONTRACT — this backs `plan-controller.ts`'s `runExecution`
 * seeding, which runs on every plan-execution send, so a parse failure must
 * never block execution:
 *   - every checkbox line (`- [ ] ` / `- [x] ` at line start, `*` bullets
 *     too) yields a todo, even when the `T<n>` id and/or `[easy|hard]` tag
 *     don't match — those parts are captured loosely (optional groups), so
 *     malformed bracket junk just stays part of the title instead of losing
 *     the line;
 *   - a document with zero checkbox lines yields `[]`;
 *   - the parser NEVER throws, regardless of input (including non-string
 *     garbage or huge adversarial documents) — it returns `[]` instead.
 *
 * Deliberately does not require a `## Todos` heading: plans are hand-edited
 * markdown files, and a user who deletes or renames the heading (or the
 * whole Todos section) shouldn't lose seeding as a result — checkbox lines
 * are found anywhere in the document.
 */

import type { HostedPlanEntry } from '../../../stores/ai';

export interface PlanTodo {
  id: string | null;
  title: string;
  difficulty?: 'easy' | 'hard';
  done: boolean;
}

const CHECKBOX_LINE =
  /^\s*[-*]\s+\[( |x|X)\]\s+(?:(T\d+)\s+)?(?:\[(easy|hard)\]\s+)?(.+)$/gm;

export function parsePlanTodos(doc: string): PlanTodo[] {
  try {
    if (typeof doc !== 'string' || doc.length === 0) return [];

    return [...doc.matchAll(CHECKBOX_LINE)].map((m) => {
      const [, check, id, difficulty, title] = m;
      const todo: PlanTodo = {
        id: id ?? null,
        title: title.trim(),
        done: check.toLowerCase() === 'x',
      };
      if (difficulty === 'easy' || difficulty === 'hard') {
        todo.difficulty = difficulty;
      }
      return todo;
    });
  } catch {
    // Execution must never be blocked by parse quality — best-effort or [].
    return [];
  }
}

/**
 * Maps parsed plan todos to the store's `HostedPlanEntry` shape.
 *
 * Used by `plan-controller.ts`'s `runExecution` to seed `hostedPlan` from the
 * plan file BEFORE the first plan-execution send of a run, so the FIRST
 * request already carries the current todo's difficulty — the metadata
 * resolver (`difficulty.ts`'s `difficultyForRequest`) reads `hostedPlan` off
 * the store, and without this the first send would go out untagged until the
 * model's own first `todo_update` call caught up. The todo-tool merge
 * (`todo-tool.ts`'s `mergeTodoDifficulty`) keeps these tags authoritative for
 * every send after that.
 */
export function planTodosToHostedPlan(todos: PlanTodo[]): HostedPlanEntry[] {
  return todos.map((t) => ({
    text: t.title,
    status: t.done ? 'done' : 'pending',
    difficulty: t.difficulty,
  }));
}
