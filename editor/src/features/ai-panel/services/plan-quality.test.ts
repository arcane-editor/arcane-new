import { describe, it, expect } from 'bun:test';
import { validatePlanDocument } from './plan-quality';

const GOOD = `# Add a character controller

## Goal
A capsule the player drives with WASD that jumps and climbs stairs.

## Context
Assets/Scripts/PlayerController.cs already exists and is empty. The project
uses the Input System package, so movement reads from PlayerInput.

## Todos
- [ ] T1 Write the movement script
- [ ] T2 Add the jump and gravity integration
- [ ] T3 Tune the controller for stairs

## Guide

### T1: Write the movement script
Edit Assets/Scripts/PlayerController.cs. Add a CharacterController field and
read the Move action each frame, feeding CharacterController.Move with a
world-space vector scaled by Time.deltaTime. Verify by entering play mode and
walking on flat ground.

### T2: Add the jump and gravity integration
In the same file, keep a vertical velocity float. Apply gravity every frame and
set it to the jump impulse when the Jump action fires and isGrounded is true.
Verify the capsule returns to the ground rather than floating.

### T3: Tune the controller for stairs
Set stepOffset to 0.3 and slopeLimit to 45 on the CharacterController component
in the Inspector. Verify by walking up and down the stair prop without the
capsule catching on a riser.

## Risks
- stepOffset larger than the capsule radius behaves unpredictably.

STOP — review and edit before execution.
`;

describe('validatePlanDocument — a good plan', () => {
  it('accepts a plan that follows the template', () => {
    const r = validatePlanDocument(GOOD);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe('validatePlanDocument — the preamble case', () => {
  // Verbatim from the bug report. This is what got written to disk and
  // presented to the user AS the plan: the model narrating before its first
  // tool call, accepted because the only check was "is the text non-empty".
  const PREAMBLE =
    "I'm going to build this around the existing SampleScene and " +
    'PlayerController.cs so everything stays wired. First, let me study the ' +
    'exact scene file structure, the current controller setup, and editor ' +
    'state — the plan needs concrete anchors.';

  it('rejects it', () => {
    const r = validatePlanDocument(PREAMBLE);
    expect(r.ok).toBe(false);
  });

  it('says it is not a plan document rather than listing every missing heading', () => {
    const r = validatePlanDocument(PREAMBLE);
    expect(r.problems[0]).toMatch(/does not start with|not a plan/i);
  });

  it('rejects an empty or whitespace answer', () => {
    expect(validatePlanDocument('').ok).toBe(false);
    expect(validatePlanDocument('   \n\n  ').ok).toBe(false);
  });

  it('rejects prose that happens to mention the headings', () => {
    const r = validatePlanDocument('I will write a ## Todos section next.');
    expect(r.ok).toBe(false);
  });
});

describe('validatePlanDocument — structure', () => {
  const drop = (section: string) =>
    GOOD.split('\n')
      .filter((l) => !l.startsWith(`## ${section}`))
      .join('\n');

  it('names each missing section', () => {
    for (const s of ['Goal', 'Context', 'Todos', 'Guide', 'Risks']) {
      const r = validatePlanDocument(drop(s));
      expect(r.ok).toBe(false);
      expect(r.problems.join(' ')).toContain(`## ${s}`);
    }
  });

  it('requires enough steps to be a plan at all', () => {
    const oneStep = GOOD.replace(/- \[ \] T2.*\n/, '').replace(/- \[ \] T3.*\n/, '');
    const r = validatePlanDocument(oneStep);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/todo/i);
  });

  it('requires the closing sentinel', () => {
    const r = validatePlanDocument(GOOD.replace('STOP — review and edit before execution.', ''));
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toContain('STOP');
  });
});

describe('validatePlanDocument — the two halves must match', () => {
  it('flags a todo with no guide entry', () => {
    const r = validatePlanDocument(GOOD.replace('### T2: Add the jump and gravity integration', '### T9: Stray'));
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toContain('T2');
  });

  it('flags a guide entry no todo claims', () => {
    const withGhost = GOOD.replace(
      '## Risks',
      '### T8: Ghost\nSomething nobody asked for.\n\n## Risks',
    );
    const r = validatePlanDocument(withGhost);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toContain('T8');
  });
});

describe('validatePlanDocument — depth', () => {
  // The point of the gate. A plan whose steps say nothing is a checklist the
  // executor has to re-derive from scratch, which is the situation planning
  // exists to avoid.
  it('rejects a guide entry that is a single vague sentence', () => {
    const thin = GOOD.replace(
      /### T1: Write the movement script[\s\S]*?\n\n### T2/,
      '### T1: Write the movement script\nDo the movement.\n\n### T2',
    );
    const r = validatePlanDocument(thin);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/T1/);
  });

  it('rejects a long guide entry that names nothing concrete', () => {
    const waffle = 'It is important to consider the various approaches here and '
      + 'weigh them carefully against one another before deciding which of the '
      + 'many possible directions the implementation should ultimately take.';
    const r = validatePlanDocument(
      GOOD.replace(
        /### T3: Tune the controller for stairs[\s\S]*?\n\n## Risks/,
        `### T3: Tune the controller for stairs\n${waffle}\n\n## Risks`,
      ),
    );
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/T3/);
  });

  it('accepts an entry anchored by a backticked identifier rather than a path', () => {
    const r = validatePlanDocument(
      GOOD.replace(
        'Set stepOffset to 0.3 and slopeLimit to 45 on the CharacterController component\nin the Inspector.',
        'Set `stepOffset` to 0.3 and `slopeLimit` to 45 on the component in the Inspector, which is the setting that decides whether a riser is treated as a step or a wall.',
      ),
    );
    expect(r.problems).toEqual([]);
  });
});

describe('validatePlanDocument — never throws', () => {
  it('survives junk input the way plan-todos.ts does', () => {
    for (const junk of [null, undefined, 42, {}, []] as unknown[]) {
      expect(() => validatePlanDocument(junk as string)).not.toThrow();
      expect(validatePlanDocument(junk as string).ok).toBe(false);
    }
  });
});
