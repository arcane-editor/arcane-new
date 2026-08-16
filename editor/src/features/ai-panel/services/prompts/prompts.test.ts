import { describe, it, expect } from 'bun:test';
import { buildAskPrompt } from './ask';
import { buildAgentPrompt } from './agent';
import { buildPlanPlanningPrompt } from './plan-planning';
import { buildPlanExecutionPrompt, buildPlanSendPrefix } from './plan-execution';

describe('prompt personas (anti-terseness regression)', () => {
  const ask = buildAskPrompt('/proj');
  const agent = buildAgentPrompt('/proj');

  it('ask prompt teaches root causes and adapts depth', () => {
    expect(ask).toContain('root cause');
    expect(ask).toContain('Match depth to the question');
    expect(ask).not.toContain('Keep examples small and self-contained');
  });

  it('agent prompt reports verification, not brevity', () => {
    expect(agent).toContain('what was verified');
    expect(agent).not.toContain('Keep prose tight');
    expect(agent).not.toContain('a brief summary');
  });

  it('both keep the grounding instructions and Unity context', () => {
    expect(ask).toContain('Investigate before answering');
    expect(agent).toContain('unity_api_search');
    expect(agent).toContain('Read before you edit');
  });
});

describe('todo_update instructions (T9)', () => {
  const agent = buildAgentPrompt('/proj');
  const planExecution = buildPlanExecutionPrompt({
    workspacePath: '/proj',
    planPath: '/proj/.arcane/plans/plan.md',
  });

  it('agent prompt has a Task tracking section requiring todo_update for multi-step work', () => {
    expect(agent).toContain('## Task tracking');
    expect(agent).toContain('todo_update');
    expect(agent).toContain('in_progress');
  });

  it('plan-execution prompt ties todo_update to plan steps', () => {
    expect(planExecution).toContain('todo_update');
    expect(planExecution).toContain('mirror the plan');
  });
});

describe('ask_user instructions (Task 2 — agent/plan-planning/plan-execution only, not ask)', () => {
  const agent = buildAgentPrompt('/proj');
  const planPlanning = buildPlanPlanningPrompt('/proj');
  const planExecution = buildPlanExecutionPrompt({
    workspacePath: '/proj',
    planPath: '/proj/.arcane/plans/plan.md',
  });

  it('agent, plan-planning, and plan-execution prompts all document ask_user', () => {
    expect(agent).toContain('ask_user');
    expect(planPlanning).toContain('ask_user');
    expect(planExecution).toContain('ask_user');
  });

  it('plan-planning prompt prefers asking before writing the plan', () => {
    expect(planPlanning).toContain('BEFORE writing the plan');
  });
});

describe('plan-execution prompt is cache-stable (cache activation §1)', () => {
  const planPath = '/proj/.arcane/plans/plan.md';
  const planContent = '## Steps\n\n- [ ] Step 1: Add ZebraQuantumPickup component';
  const prompt = buildPlanExecutionPrompt({ workspacePath: '/proj', planPath });

  it('references the plan file path but never embeds the plan body', () => {
    expect(prompt).toContain(planPath);
    expect(prompt).not.toContain('ZebraQuantumPickup');
  });

  it('buildPlanSendPrefix carries the full plan only on the first send', () => {
    const first = buildPlanSendPrefix(false, planPath, planContent);
    expect(first).toContain(`## Approved plan (${planPath})`);
    expect(first).toContain('ZebraQuantumPickup');

    const later = buildPlanSendPrefix(true, planPath, planContent);
    expect(later).toContain(planPath);
    expect(later).not.toContain('ZebraQuantumPickup');
    expect(later).toContain('re-read');
  });
});

// ---------------------------------------------------------------------------
// Bridge loss during recompiles is NOT a step failure. Real transcripts: the
// execution prompt's stop-on-failure rule made the model stop and "wait for
// the user" whenever a compile-verification note said the bridge was
// unavailable — which is the EXPECTED state during every domain reload the
// agent's own writes trigger. Script work never needs the live editor.
// ---------------------------------------------------------------------------
import { buildPlanPlanningPrompt as planningPromptFor } from './plan-planning';
import { buildPlanExecutionPrompt as executionPromptFor } from './plan-execution';

describe('bridge-independence + step ordering (plan prompts)', () => {
  const planning = planningPromptFor('/proj');
  const execution = executionPromptFor({ workspacePath: '/proj', planPath: '/proj/.arcane/plans/p.md' });

  it('planning orders all script steps before any editor-side steps', () => {
    expect(planning).toContain('scripts first, editor last');
    expect(planning.toLowerCase()).toContain('before any step that drives the unity editor');
  });

  it('execution says bridge loss is not a failure and script work continues', () => {
    expect(execution.toLowerCase()).toContain('not required');
    expect(execution).toContain('NOT a step failure');
    expect(execution.toLowerCase()).toContain('reconnects automatically');
  });

  it('execution prefers remaining script steps while the editor is unavailable', () => {
    expect(execution.toLowerCase()).toContain('script steps first');
  });
});

// ---------------------------------------------------------------------------
// Progress must survive a re-plan. A regenerated plan used to come back with
// every step unchecked, and execution mirrored todos as ALL pending — so one
// regenerate wiped the visible progress of everything already completed.
// ---------------------------------------------------------------------------
describe('plan progress carry-over (regenerate edge case)', () => {
  const planning = planningPromptFor('/proj');
  const execution = executionPromptFor({ workspacePath: '/proj', planPath: '/proj/.arcane/plans/p.md' });

  it('planning carries completed steps forward pre-checked, never resetting them', () => {
    expect(planning).toContain('Never reset completed work');
    expect(planning).toContain('- [x]');
  });

  it('execution mirrors todo state from the plan checkboxes, not all-pending', () => {
    expect(execution).toContain('mirror the plan');
    expect(execution).not.toContain('all `pending`');
    expect(execution.toLowerCase()).toContain('already checked');
  });
});
