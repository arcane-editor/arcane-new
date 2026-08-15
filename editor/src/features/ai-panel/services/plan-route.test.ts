import { describe, it, expect } from 'bun:test';
import { routePlanSend } from './plan-route';

// The bug this pins down: the composer used to branch on `mode === 'plan'`
// alone and ALWAYS started a fresh planning run — so typing "restart" after a
// stopped execution re-created the plan (with the write tools stripped, the
// model couldn't resume even if it wanted to). Routing must consult the phase.
describe('routePlanSend', () => {
  it('resumes when a plan is awaiting execution', () => {
    expect(routePlanSend('awaiting-execute', '/ws/.arcane/plans/p.md')).toBe('resume');
  });

  it('resumes when the phase is stuck at executing (recovery after a crashed send)', () => {
    expect(routePlanSend('executing', '/ws/.arcane/plans/p.md')).toBe('resume');
  });

  it('plans fresh when there is no active plan file, whatever the phase says', () => {
    expect(routePlanSend('awaiting-execute', null)).toBe('plan');
    expect(routePlanSend('executing', null)).toBe('plan');
  });

  it('plans fresh from idle and while planning', () => {
    expect(routePlanSend('idle', '/ws/.arcane/plans/p.md')).toBe('plan');
    expect(routePlanSend('planning', '/ws/.arcane/plans/p.md')).toBe('plan');
    expect(routePlanSend('idle', null)).toBe('plan');
  });
});
