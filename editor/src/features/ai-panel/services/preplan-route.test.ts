import { describe, it, expect } from 'bun:test';
import { routeAgentSend } from './preplan-route';

describe('routeAgentSend', () => {
  it('preplans when enabled and there is no plan yet (null)', () => {
    expect(routeAgentSend(true, null)).toBe('preplan');
  });

  it('preplans when enabled and the plan is an empty list', () => {
    expect(routeAgentSend(true, [])).toBe('preplan');
  });

  it('preplans when enabled and every item is done', () => {
    expect(routeAgentSend(true, [{ status: 'done' }, { status: 'done' }])).toBe('preplan');
  });

  it('executes when enabled but work remains in progress', () => {
    expect(routeAgentSend(true, [{ status: 'done' }, { status: 'in_progress' }])).toBe('execute');
  });

  it('executes when enabled but work remains pending', () => {
    expect(routeAgentSend(true, [{ status: 'pending' }])).toBe('execute');
  });

  it('always executes when disabled for the tier, regardless of plan state', () => {
    expect(routeAgentSend(false, null)).toBe('execute');
    expect(routeAgentSend(false, [])).toBe('execute');
    expect(routeAgentSend(false, [{ status: 'done' }])).toBe('execute');
    expect(routeAgentSend(false, [{ status: 'pending' }])).toBe('execute');
  });
});
