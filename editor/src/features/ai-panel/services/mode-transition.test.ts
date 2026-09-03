import { describe, it, expect } from 'bun:test';
import {
  planModeTransition,
  normalizeLivePlanState,
  PLAN_PARKED_NOTICE,
  type ModeTransitionInput,
} from './mode-transition';

const base: ModeTransitionInput = {
  from: 'agent',
  to: 'ask',
  planPhase: 'idle',
  activePlanPath: null,
  isAgentRunning: false,
};
const t = (o: Partial<ModeTransitionInput> = {}) => planModeTransition({ ...base, ...o });

/**
 * Some source mode other than `to`, for looping over every destination
 * without ever hitting the `from === to` noop cell by accident.
 */
function otherThan(to: 'ask' | 'agent' | 'plan'): 'ask' | 'agent' | 'plan' {
  return to === 'plan' ? 'agent' : 'plan';
}

describe('planModeTransition — running/noop rows', () => {
  it('blocks any switch while the agent is running, whatever the phase', () => {
    expect(t({ isAgentRunning: true, planPhase: 'awaiting-execute', activePlanPath: '/p.md' })).toEqual({
      kind: 'blocked',
      reason: 'running',
    });
    expect(t({ isAgentRunning: true, planPhase: 'idle' })).toEqual({ kind: 'blocked', reason: 'running' });
  });

  it('blocked takes priority over noop — a same-mode click while running still reports why', () => {
    expect(t({ from: 'plan', to: 'plan', isAgentRunning: true, planPhase: 'executing', activePlanPath: '/p.md' })).toEqual({
      kind: 'blocked',
      reason: 'running',
    });
  });

  it('is a noop when the destination mode is already active', () => {
    expect(t({ from: 'plan', to: 'plan', planPhase: 'awaiting-execute', activePlanPath: '/p.md' })).toEqual({
      kind: 'noop',
    });
    expect(t({ from: 'agent', to: 'agent' })).toEqual({ kind: 'noop' });
  });
});

describe('planModeTransition — idle phase', () => {
  it('switches plainly for every destination', () => {
    for (const to of ['ask', 'agent', 'plan'] as const) {
      expect(t({ from: otherThan(to), to, planPhase: 'idle', activePlanPath: null })).toEqual({
        kind: 'switch',
        mode: to,
        planPhase: 'idle',
        activePlanPath: null,
      });
    }
  });
});

describe('planModeTransition — planning (not running)', () => {
  it('resets to idle with a null path for every destination — the run died before writing a file', () => {
    for (const to of ['ask', 'agent', 'plan'] as const) {
      expect(t({ from: otherThan(to), to, planPhase: 'planning', activePlanPath: '/ws/.unityide/plans/p.md' })).toEqual({
        kind: 'switch',
        mode: to,
        planPhase: 'idle',
        activePlanPath: null,
      });
    }
  });
});

describe('planModeTransition — awaiting-execute, path set', () => {
  it('parks the plan with the notice when leaving plan mode', () => {
    for (const to of ['ask', 'agent'] as const) {
      expect(t({ from: 'plan', to, planPhase: 'awaiting-execute', activePlanPath: '/ws/.unityide/plans/p.md' })).toEqual({
        kind: 'switch',
        mode: to,
        planPhase: 'awaiting-execute',
        activePlanPath: '/ws/.unityide/plans/p.md',
        notice: PLAN_PARKED_NOTICE,
      });
    }
  });

  it('pins the exact notice string once', () => {
    expect(PLAN_PARKED_NOTICE).toBe('Plan parked. Switch back to Plan mode to execute or resume it.');
  });

  it('switches to plan mode with the card visible and no notice', () => {
    expect(t({ from: 'agent', to: 'plan', planPhase: 'awaiting-execute', activePlanPath: '/ws/.unityide/plans/p.md' })).toEqual({
      kind: 'switch',
      mode: 'plan',
      planPhase: 'awaiting-execute',
      activePlanPath: '/ws/.unityide/plans/p.md',
    });
  });
});

describe('planModeTransition — awaiting-execute, no path', () => {
  it('resets to idle for every destination — nothing to park', () => {
    for (const to of ['ask', 'agent', 'plan'] as const) {
      expect(t({ from: otherThan(to), to, planPhase: 'awaiting-execute', activePlanPath: null })).toEqual({
        kind: 'switch',
        mode: to,
        planPhase: 'idle',
        activePlanPath: null,
      });
    }
  });
});

describe('planModeTransition — executing (not running)', () => {
  it('parks as interrupted with the notice when leaving plan mode', () => {
    for (const to of ['ask', 'agent'] as const) {
      expect(t({ from: 'plan', to, planPhase: 'executing', activePlanPath: '/ws/.unityide/plans/p.md' })).toEqual({
        kind: 'switch',
        mode: to,
        planPhase: 'interrupted',
        activePlanPath: '/ws/.unityide/plans/p.md',
        notice: PLAN_PARKED_NOTICE,
      });
    }
  });

  it('switches to plan mode as interrupted with no notice', () => {
    expect(t({ from: 'agent', to: 'plan', planPhase: 'executing', activePlanPath: '/ws/.unityide/plans/p.md' })).toEqual({
      kind: 'switch',
      mode: 'plan',
      planPhase: 'interrupted',
      activePlanPath: '/ws/.unityide/plans/p.md',
    });
  });
});

describe('planModeTransition — interrupted, path set', () => {
  it('parks the plan with the notice when leaving plan mode', () => {
    for (const to of ['ask', 'agent'] as const) {
      expect(t({ from: 'plan', to, planPhase: 'interrupted', activePlanPath: '/ws/.unityide/plans/p.md' })).toEqual({
        kind: 'switch',
        mode: to,
        planPhase: 'interrupted',
        activePlanPath: '/ws/.unityide/plans/p.md',
        notice: PLAN_PARKED_NOTICE,
      });
    }
  });

  it('switches to plan mode with the card visible and no notice', () => {
    expect(t({ from: 'agent', to: 'plan', planPhase: 'interrupted', activePlanPath: '/ws/.unityide/plans/p.md' })).toEqual({
      kind: 'switch',
      mode: 'plan',
      planPhase: 'interrupted',
      activePlanPath: '/ws/.unityide/plans/p.md',
    });
  });
});

describe('planModeTransition — interrupted, no path', () => {
  it('resets to idle for every destination', () => {
    for (const to of ['ask', 'agent', 'plan'] as const) {
      expect(t({ from: otherThan(to), to, planPhase: 'interrupted', activePlanPath: null })).toEqual({
        kind: 'switch',
        mode: to,
        planPhase: 'idle',
        activePlanPath: null,
      });
    }
  });
});

describe('normalizeLivePlanState', () => {
  it('degrades any phase with no path to idle', () => {
    expect(normalizeLivePlanState('executing', null, true)).toEqual({ planPhase: 'idle', activePlanPath: null });
    expect(normalizeLivePlanState('awaiting-execute', null, false)).toEqual({ planPhase: 'idle', activePlanPath: null });
  });

  it('demotes a dead planning run to idle', () => {
    expect(normalizeLivePlanState('planning', '/p.md', false)).toEqual({ planPhase: 'idle', activePlanPath: null });
  });

  it('leaves a live planning run alone', () => {
    expect(normalizeLivePlanState('planning', '/p.md', true)).toEqual({ planPhase: 'planning', activePlanPath: '/p.md' });
  });

  it('demotes a dead execution run to interrupted, keeping the path', () => {
    expect(normalizeLivePlanState('executing', '/p.md', false)).toEqual({
      planPhase: 'interrupted',
      activePlanPath: '/p.md',
    });
  });

  it('leaves a live execution run alone', () => {
    expect(normalizeLivePlanState('executing', '/p.md', true)).toEqual({ planPhase: 'executing', activePlanPath: '/p.md' });
  });

  it('leaves awaiting-execute and interrupted alone regardless of isAgentRunning', () => {
    expect(normalizeLivePlanState('awaiting-execute', '/p.md', false)).toEqual({
      planPhase: 'awaiting-execute',
      activePlanPath: '/p.md',
    });
    expect(normalizeLivePlanState('interrupted', '/p.md', false)).toEqual({
      planPhase: 'interrupted',
      activePlanPath: '/p.md',
    });
  });
});
