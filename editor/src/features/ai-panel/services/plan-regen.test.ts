import { describe, it, expect } from 'bun:test';
import { buildRegeneratePrompt } from './plan-regen';

// Regenerate used to draft blind: startPlanning(pendingPrompt) with no
// reference to the previous plan, so the new plan re-listed completed work
// unchecked and executing it reset every done todo to pending.
describe('buildRegeneratePrompt', () => {
  const PRIOR = {
    path: '/ws/.arcane/plans/20260816-0929-game.md',
    content: '# Game\n\n## Steps\n- [x] **Step 1: Health.cs** — done\n- [ ] **Step 2: Enemy.cs** — todo\n',
  };

  it('returns the original prompt untouched when there is no prior plan', () => {
    expect(buildRegeneratePrompt('build a game', null)).toBe('build a game');
  });

  it('embeds the prior plan content and path', () => {
    const out = buildRegeneratePrompt('build a game', PRIOR);
    expect(out).toContain('build a game');
    expect(out).toContain(PRIOR.path);
    expect(out).toContain('- [x] **Step 1: Health.cs**');
  });

  it('instructs carrying checked steps forward pre-checked, never resetting them', () => {
    const out = buildRegeneratePrompt('build a game', PRIOR);
    expect(out).toContain('pre-checked');
    expect(out.toLowerCase()).toContain('do not reset completed');
  });

  // Task 12: difficulty tags must survive a re-plan the same way checked
  // state already does — otherwise Regenerate silently strips them.
  it('instructs carrying each kept todo\'s [easy]/[hard] tag forward unchanged', () => {
    const out = buildRegeneratePrompt('build a game', PRIOR);
    expect(out).toContain('[easy]');
    expect(out).toContain('[hard]');
    expect(out.toLowerCase()).toContain('carry forward');
  });
});
