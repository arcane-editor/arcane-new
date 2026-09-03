import { describe, it, expect } from 'bun:test';
import { composerPlaceholder, type PlaceholderInput } from './composer-copy';

const base: PlaceholderInput = {
  agent: 'hosted',
  mode: 'agent',
  planRoute: 'plan',
  pendingQuestion: false,
};
const p = (o: Partial<PlaceholderInput> = {}) => composerPlaceholder({ ...base, ...o });

describe('composerPlaceholder — UnityIDE', () => {
  it('keeps the per-mode copy the UnityIDE loop actually honours', () => {
    expect(p({ mode: 'ask' })).toContain('Ask a question');
    expect(p({ mode: 'plan' })).toContain('to plan');
    expect(p({ mode: 'agent' })).toBe('Plan, build, edit. @ for context, ⏎ to send.');
  });

  // The placeholder is a promise about what Enter does, and Enter's behaviour
  // on a written-but-unstarted plan changed: it revises rather than builds.
  // Copy that still said "continues the current plan" would be describing the
  // bug this replaced.
  it('promises revision while a plan is waiting to be executed', () => {
    const text = p({ mode: 'plan', planRoute: 'revise' });
    expect(text).toContain('revises the plan');
    expect(text).not.toContain('continues the current plan');
  });

  // The wrap-up text after a stopped run tells the user to reply "continue"
  // to pick it back up (StoppedBlock's Resume button sends that literal
  // text). The placeholder has to promise the same thing, not "guides the
  // run in progress" — there is no run in progress once the phase is
  // 'interrupted', only a plan file with [x] ticks to continue from.
  it('promises resuming from where the plan stopped', () => {
    expect(p({ mode: 'plan', planRoute: 'resume' })).toContain('resumes the plan from where it stopped');
  });
});

describe('composerPlaceholder — external agent', () => {
  /**
   * The reported bug: Claude Code was selected and the composer still read
   * "⏎ to plan", because the placeholder was driven by UnityIDE's `mode`. Claude
   * runs its own loop and never reads that value, so promising plan-mode
   * behaviour was a straight lie about what Enter would do.
   */
  it('never promises UnityIDE plan-mode behaviour', () => {
    for (const mode of ['ask', 'plan', 'agent'] as const) {
      const text = p({ agent: 'claude', mode, planRoute: 'revise' });
      expect(text.toLowerCase()).not.toContain('plan');
    }
  });

  it('names the agent that will answer', () => {
    expect(p({ agent: 'claude' })).toContain('Claude Code');
  });

  it('is the same regardless of the UnityIDE mode left behind', () => {
    const texts = new Set(
      (['ask', 'plan', 'agent'] as const).map((mode) => p({ agent: 'claude', mode })),
    );
    expect(texts.size).toBe(1);
  });
});

describe('composerPlaceholder — pending question', () => {
  it('outranks mode and agent alike', () => {
    for (const agent of ['hosted', 'claude'] as const) {
      expect(p({ agent, pendingQuestion: true })).toContain("Answer the agent's question");
    }
  });
});
