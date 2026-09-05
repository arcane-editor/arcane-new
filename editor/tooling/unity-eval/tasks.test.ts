/**
 * Structural self-tests for `TASKS` (`tasks.ts`) — pure, no LLM. Guards
 * against the class of mistakes that are easy to make by hand when growing
 * the suite (duplicate ids, typo'd fixture names, a check kind that doesn't
 * round-trip through `CheckSpec`, an ask-mode task that can never pass
 * because it asserts a file mutation with no write tool available, or an
 * agent-mode codegen task with no file-level check at all).
 */

import { describe, it, expect } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { TASKS } from './tasks';
import type { CheckSpec } from './eval-types';
import { runChecks } from './checks';

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));

// Mirrors the `CheckSpec` union in `eval-types.ts` — kept as an explicit list
// (rather than derived) because TS unions don't exist at runtime.
const VALID_CHECK_KINDS: CheckSpec['type'][] = [
  'file_exists',
  'file_contains',
  'file_not_contains',
  'analyzer_clean',
  'answer_matches',
  'answer_not_matches',
  'tool_called',
  'tool_not_called',
];

const FILE_MUTATION_CHECK_KINDS: CheckSpec['type'][] = ['file_exists', 'file_contains', 'file_not_contains'];

describe('TASKS structural integrity', () => {
  it('has every task id unique', () => {
    const ids = TASKS.map((t) => t.id);
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(duplicates).toEqual([]);
  });

  it('references only fixtures that exist on disk', () => {
    const missing = TASKS.filter((t) => {
      const dir = join(FIXTURES_DIR, t.fixture);
      return !existsSync(dir) || !statSync(dir).isDirectory();
    }).map((t) => `${t.id} -> ${t.fixture}`);
    expect(missing).toEqual([]);
  });

  it('uses only valid CheckSpec kinds', () => {
    const invalid: string[] = [];
    for (const task of TASKS) {
      for (const check of task.checks) {
        if (!VALID_CHECK_KINDS.includes(check.type)) {
          invalid.push(`${task.id}: ${check.type}`);
        }
      }
    }
    expect(invalid).toEqual([]);
  });

  it('gives every task at least one check', () => {
    const empty = TASKS.filter((t) => t.checks.length === 0).map((t) => t.id);
    expect(empty).toEqual([]);
  });

  it('never asserts a file-mutation check on a read-only task (no write tool in ask or plan mode)', () => {
    const offenders: string[] = [];
    for (const task of TASKS) {
      if (task.mode !== 'ask' && task.mode !== 'plan') continue;
      for (const check of task.checks) {
        if (FILE_MUTATION_CHECK_KINDS.includes(check.type)) {
          offenders.push(`${task.id}: ${check.type}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('gives every agent-mode codegen task at least one file-level check', () => {
    const offenders: string[] = [];
    for (const task of TASKS) {
      if (task.family !== 'codegen' || task.mode !== 'agent') continue;
      const hasFileCheck = task.checks.some((c) => FILE_MUTATION_CHECK_KINDS.includes(c.type));
      if (!hasFileCheck) offenders.push(task.id);
    }
    expect(offenders).toEqual([]);
  });

  it('has ~24 tasks (grown from the original 12 seed tasks)', () => {
    expect(TASKS.length).toBeGreaterThanOrEqual(24);
  });
});

/**
 * The plan family grades a DOCUMENT, so every one of its checks is a regex
 * over the final answer — and a regex that is subtly wrong fails silently in
 * the most expensive way possible: it passes every run, and the eval reports
 * green while measuring nothing.
 *
 * (One already did. These checks were first written with `\A` for
 * start-of-string, which JavaScript does not have — `\A` matches a literal
 * "A", so the "must not open with a preamble" check would have accepted the
 * exact answer it exists to reject.)
 *
 * So the checks are run here against two documents whose verdict is known: a
 * plan that should pass every check, and the real reply from the bug report
 * that must fail the ones that matter.
 */
describe('plan-family checks actually discriminate', () => {
  const planTasks = TASKS.filter((t) => t.family === 'plan');

  const GOOD_PLAN = `# Character controller for the player capsule

## Goal
WASD movement, a space-bar jump, and stairs the capsule climbs cleanly.

## Context
Assets/Scripts/PlayerController.cs is the entry point. Movement reads through
the project's own input setup.

## Todos
- [ ] T1 Add the CharacterController component fields
- [ ] T2 Implement horizontal movement
- [ ] T3 Integrate gravity and the jump impulse
- [ ] T4 Tune stepOffset and slopeLimit for the stairs
- [ ] T5 Set the scene up by hand

## Guide

### T1: Add the CharacterController component fields
Edit Assets/Scripts/PlayerController.cs and cache the CharacterController.

### T2: Implement horizontal movement
Feed CharacterController.Move a world-space delta scaled by Time.deltaTime.

### T3: Integrate gravity and the jump impulse
Track velocity.y, apply Physics.gravity, and clamp to -2f while isGrounded.

### T4: Tune stepOffset and slopeLimit for the stairs
Set stepOffset to 0.3 and slopeLimit to 45.

### T5: Set the scene up by hand
In the Inspector, add the CharacterController component to the Player capsule
and assign the movement values above.

## Risks
- A stepOffset above the capsule radius behaves unpredictably.

STOP — review and edit before execution.
`;

  // Verbatim from the report that prompted the family.
  const PREAMBLE =
    "I'm going to build this around the existing SampleScene and " +
    'PlayerController.cs so everything stays wired. First, let me study the ' +
    'exact scene file structure, the current controller setup, and editor ' +
    'state — the plan needs concrete anchors.';

  const run = (spec: { type: string; pattern?: string; flags?: string }, answer: string) => {
    const hit = new RegExp(spec.pattern!, spec.flags).test(answer);
    return spec.type === 'answer_matches' ? hit : !hit;
  };

  it('added the family at all', () => {
    expect(planTasks.length).toBeGreaterThan(0);
  });

  it('every plan task is scored purely on the answer', () => {
    for (const task of planTasks) {
      for (const check of task.checks) {
        expect(['answer_matches', 'answer_not_matches']).toContain(check.type);
      }
    }
  });

  it('uses no regex syntax JavaScript does not have', () => {
    for (const task of planTasks) {
      for (const check of task.checks) {
        const pattern = (check as { pattern: string }).pattern;
        expect(pattern).not.toContain('\\A');
        expect(pattern).not.toContain('\\z');
        expect(pattern).not.toContain('\\Z');
        expect(() => new RegExp(pattern, (check as { flags?: string }).flags)).not.toThrow();
      }
    }
  });

  it('passes a plan that answers the request', () => {
    const task = planTasks.find((t) => t.id === 'plan-character-controller')!;
    const failed = task.checks
      .filter((c) => !run(c as never, GOOD_PLAN))
      .map((c) => `${c.type} ${(c as { pattern: string }).pattern}`);
    expect(failed).toEqual([]);
  });

  it('fails the preamble that started all this', () => {
    const task = planTasks.find((t) => t.id === 'plan-character-controller')!;
    const failed = task.checks.filter((c) => !run(c as never, PREAMBLE));
    // Not just "some check fails" — the two that encode the actual complaint.
    expect(failed.length).toBeGreaterThan(5);
    expect(run({ type: 'answer_matches', pattern: '^\\s*#\\s+\\S' }, PREAMBLE)).toBe(false);
    expect(
      run(
        { type: 'answer_not_matches', pattern: "^\\s*(I'm going to|I will|First, let me|Let me)" },
        PREAMBLE,
      ),
    ).toBe(false);
  });

  it('counts five todos rather than matching one five times', () => {
    const five = task5Check();
    expect(run(five, GOOD_PLAN)).toBe(true);
    const threeTodos = GOOD_PLAN.replace(/- \[ \] T4[\s\S]*?\n- \[ \] T5.*\n/, '');
    expect(run(five, threeTodos)).toBe(false);
  });

  function task5Check() {
    const task = planTasks.find((t) => t.id === 'plan-character-controller')!;
    return task.checks.find((c) =>
      (c as { pattern?: string }).pattern?.includes('){5}'),
    ) as { type: string; pattern: string; flags?: string };
  }
});

/**
 * `grounding-ui-stack` (Task 18): a discrimination check, same shape as the
 * plan family's above — a known-good answer must pass every check, a
 * known-bad one must fail at least one. Both `answer_matches`/
 * `answer_not_matches`, so this reuses the plan family's own `run` logic
 * rather than round-tripping through `runChecks`'s file I/O.
 */
describe('grounding-ui-stack checks discriminate uGUI from UI Toolkit answers', () => {
  const task = TASKS.find((t) => t.id === 'grounding-ui-stack')!;

  const run = (spec: { type: string; pattern?: string; flags?: string }, answer: string) => {
    const hit = new RegExp(spec.pattern!, spec.flags).test(answer);
    return spec.type === 'answer_matches' ? hit : !hit;
  };

  const GOOD_ANSWER =
    "This project uses Unity's built-in UI (uGUI) — build the menu as a child of the existing " +
    'Canvas, with a RectTransform and a couple of Button components, the same way the rest of the ' +
    'project builds screens.';

  // The wrong stack for this project: it recommends UI Toolkit's runtime
  // component, which nothing in a Canvas-only scene can display.
  const BAD_ANSWER =
    'Add a UIDocument component to a GameObject and author the menu as UXML with a UI Toolkit ' +
    'PanelSettings asset.';

  it('added the task', () => {
    expect(task).toBeDefined();
  });

  it('passes an answer grounded in the project\'s actual uGUI/Canvas setup', () => {
    const failed = task.checks.filter((c) => !run(c as never, GOOD_ANSWER));
    expect(failed).toEqual([]);
  });

  it('fails an answer that recommends UIDocument/UI Toolkit', () => {
    const failed = task.checks.filter((c) => !run(c as never, BAD_ANSWER));
    expect(failed.length).toBeGreaterThan(0);
  });
});

/**
 * `codegen-ui-hud` (Task 18): unlike the answer-graded families above, this
 * task's checks are file-based (`file_exists`/`file_not_contains`), so the
 * discrimination test round-trips through the real `runChecks` against an
 * actual temp dir rather than reimplementing the check logic — the same
 * approach `checks.test.ts` uses for its own fixtures.
 */
/**
 * A screen that is actually finished: markup that REFERENCES its stylesheet,
 * and a stylesheet that paints. Both halves matter — the original fixture here
 * had no `<Style src>` at all, which is the exact shape of the "hardly any css
 * applied" complaint and used to pass this task.
 */
const GOOD_UXML =
  '<ui:UXML xmlns:ui="UnityEngine.UIElements">' +
  '<Style src="PauseMenu.uss" />' +
  '<ui:VisualElement name="pause-root" class="pause" /></ui:UXML>';
const GOOD_USS =
  '.pause {\n  flex-grow: 1;\n  background-color: rgba(0, 0, 0, 0.6);\n  border-radius: 4px;\n}\n';

describe('codegen-ui-hud checks discriminate valid USS from the seeded box-shadow trap', () => {
  const task = TASKS.find((t) => t.id === 'codegen-ui-hud')!;

  it('added the task', () => {
    expect(task).toBeDefined();
  });

  it('passes a new screen written with valid USS', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-tasks-ui-hud-good-'));
    try {
      await mkdir(join(dir, 'Assets/UI'), { recursive: true });
      await writeFile(join(dir, 'Assets/UI/PauseMenu.uxml'), GOOD_UXML);
      await writeFile(join(dir, 'Assets/UI/PauseMenu.uss'), GOOD_USS);
      const results = await runChecks(task.checks, { workDir: dir, finalAnswer: '' });
      expect(results.every((r) => r.pass)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails a new screen whose USS repeats the seeded Theme.uss box-shadow mistake', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-tasks-ui-hud-bad-'));
    try {
      await mkdir(join(dir, 'Assets/UI'), { recursive: true });
      await writeFile(
        join(dir, 'Assets/UI/PauseMenu.uxml'),
        '<ui:UXML xmlns:ui="UnityEngine.UIElements"><ui:VisualElement name="pause-root" class="pause" /></ui:UXML>',
      );
      await writeFile(
        join(dir, 'Assets/UI/PauseMenu.uss'),
        '.pause {\n  flex-grow: 1;\n  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);\n}\n',
      );
      const results = await runChecks(task.checks, { workDir: dir, finalAnswer: '' });
      expect(results.every((r) => r.pass)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails a stylesheet the document never references — it styles nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-tasks-ui-hud-unref-'));
    try {
      await mkdir(join(dir, 'Assets/UI'), { recursive: true });
      // Both files exist and the USS is perfectly valid. It reaches nothing.
      await writeFile(
        join(dir, 'Assets/UI/PauseMenu.uxml'),
        '<ui:UXML xmlns:ui="UnityEngine.UIElements"><ui:VisualElement name="pause-root" class="pause" /></ui:UXML>',
      );
      await writeFile(join(dir, 'Assets/UI/PauseMenu.uss'), GOOD_USS);
      const results = await runChecks(task.checks, { workDir: dir, finalAnswer: '' });
      expect(results.some((r) => !r.pass)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails a stylesheet that lays out but never paints', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-tasks-ui-hud-flat-'));
    try {
      await mkdir(join(dir, 'Assets/UI'), { recursive: true });
      await writeFile(join(dir, 'Assets/UI/PauseMenu.uxml'), GOOD_UXML);
      await writeFile(
        join(dir, 'Assets/UI/PauseMenu.uss'),
        '.pause {\n  flex-grow: 1;\n  flex-direction: column;\n  padding: 16px;\n}\n',
      );
      const results = await runChecks(task.checks, { workDir: dir, finalAnswer: '' });
      expect(results.some((r) => !r.pass)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails a stylesheet using a unit unity_ui_write refuses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-tasks-ui-hud-units-'));
    try {
      await mkdir(join(dir, 'Assets/UI'), { recursive: true });
      await writeFile(join(dir, 'Assets/UI/PauseMenu.uxml'), GOOD_UXML);
      await writeFile(
        join(dir, 'Assets/UI/PauseMenu.uss'),
        '.pause {\n  background-color: black;\n  font-size: 1.5rem;\n}\n',
      );
      const results = await runChecks(task.checks, { workDir: dir, finalAnswer: '' });
      expect(results.some((r) => !r.pass)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails when the new files were never written at all', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-tasks-ui-hud-missing-'));
    try {
      const results = await runChecks(task.checks, { workDir: dir, finalAnswer: '' });
      expect(results.every((r) => r.pass)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
