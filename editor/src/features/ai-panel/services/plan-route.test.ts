import { describe, it, expect } from 'bun:test';
import { routePlanSend } from './plan-route';

// The bug this pins down: the composer used to branch on `mode === 'plan'`
// alone and ALWAYS started a fresh planning run — so typing "restart" after a
// stopped execution re-created the plan (with the write tools stripped, the
// model couldn't resume even if it wanted to). Routing must consult the phase.
describe('routePlanSend', () => {
  // The second bug, and the reason 'revise' exists: a plan awaiting execution
  // used to RESUME on typed text. So the obvious way to comment on a plan you
  // were still reading — type a sentence — handed the model the write tools
  // and started building. Execution belongs to the Execute button.
  it('revises when a plan is written but not yet started', () => {
    expect(routePlanSend('awaiting-execute', '/ws/.unityide/plans/p.md')).toBe('revise');
  });

  it('resumes when the phase is stuck at executing (recovery after a crashed send)', () => {
    expect(routePlanSend('executing', '/ws/.unityide/plans/p.md')).toBe('resume');
  });

  // The wrap-up text after a capped/aborted/errored run tells the user to
  // reply "continue" (StoppedBlock's Resume button sends that literal text —
  // see composer-dispatch.ts). Routing 'interrupted' anywhere but 'resume'
  // would make that promise false: the composer would silently start a fresh
  // planning run instead, stripping the write tools mid-plan.
  it("resumes an interrupted run so 'continue' does what the wrap-up text promised", () => {
    expect(routePlanSend('interrupted', '/ws/.unityide/plans/p.md')).toBe('resume');
  });

  it('never revises without a plan file to revise', () => {
    expect(routePlanSend('awaiting-execute', null)).toBe('plan');
  });

  it('plans fresh when there is no active plan file, whatever the phase says', () => {
    expect(routePlanSend('awaiting-execute', null)).toBe('plan');
    expect(routePlanSend('executing', null)).toBe('plan');
    expect(routePlanSend('interrupted', null)).toBe('plan');
  });

  it('plans fresh from idle and while planning', () => {
    expect(routePlanSend('idle', '/ws/.unityide/plans/p.md')).toBe('plan');
    expect(routePlanSend('planning', '/ws/.unityide/plans/p.md')).toBe('plan');
    expect(routePlanSend('idle', null)).toBe('plan');
  });
});
