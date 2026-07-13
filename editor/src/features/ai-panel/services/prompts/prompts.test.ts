import { describe, it, expect } from 'bun:test';
import { buildAskPrompt } from './ask';
import { buildAgentPrompt } from './agent';
import { buildPlanExecutionPrompt } from './plan-execution';

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
    planContent: '## Steps\n\n- [ ] Step 1: Add CoinPickup component',
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
