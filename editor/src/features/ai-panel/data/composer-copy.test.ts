import { describe, it, expect } from 'bun:test';
import { composerPlaceholder, type PlaceholderInput } from './composer-copy';

const base: PlaceholderInput = {
  agent: 'hosted',
  mode: 'agent',
  planResumePending: false,
  pendingQuestion: false,
};
const p = (o: Partial<PlaceholderInput> = {}) => composerPlaceholder({ ...base, ...o });

describe('composerPlaceholder — UnityIDE', () => {
  it('keeps the per-mode copy the UnityIDE loop actually honours', () => {
    expect(p({ mode: 'ask' })).toContain('Ask a question');
    expect(p({ mode: 'plan' })).toContain('to plan');
    expect(p({ mode: 'agent' })).toBe('Plan, build, edit. @ for context, ⏎ to send.');
  });

  it('says a message continues an unfinished plan', () => {
    expect(p({ mode: 'plan', planResumePending: true })).toContain('continues the current plan');
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
      const text = p({ agent: 'claude', mode, planResumePending: true });
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
