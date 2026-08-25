import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// `EffortSelector.tsx` can't be imported here to render it: it statically
// imports `stores/ai.ts`, whose module graph (the ai-panel barrel's
// `AiChatPanel`/`MaximizedAiOverlay` exports) transitively touches `document`
// at module-eval time — fatal under plain `bun test` (see
// `session-persistence.test.ts`'s header for the same constraint, and
// `keybinding-parity.test.ts` for the same source-text technique applied to a
// different cross-cutting check). The effort-gating LOGIC itself
// (`clampEffort`/`effortLockMessage`/`restoreEffort`, `allowedEfforts`) is
// fully unit-tested directly (`effort.test.ts`, `server-config.test.ts`) —
// this file only pins the WIRING between that logic and the rendered bars,
// which a regex is exactly precise enough to check.
const SRC = readFileSync(path.resolve(import.meta.dir, './EffortSelector.tsx'), 'utf8');

describe('EffortSelector — plan-gated pill (fail-closed)', () => {
  it('derives the allowed set from server-config + auth plan (never a hardcoded ladder)', () => {
    expect(SRC).toMatch(/allowed\s*=\s*allowedEfforts\(config,\s*plan\)/);
    expect(SRC).toMatch(/useServerConfigStore\(\(s\)\s*=>\s*s\.config\)/);
    expect(SRC).toMatch(/useAuthStore\(\(s\)\s*=>\s*s\.plan\)/);
  });

  /**
   * The gating survived the bars → pill rewrite, it just moved: there is no
   * per-level button to lock any more, so "locked" now means the account has
   * nothing to cycle TO, and the pill states the level instead of pretending
   * to be a control.
   */
  it('treats a single-level plan as locked', () => {
    expect(SRC).toMatch(/const locked = allowed\.length <= 1/);
  });

  it('a locked pill has no click handler and stays disabled', () => {
    // No handler at all rather than a disabled attribute alone, so a stray
    // click can never race a re-render that briefly clears `disabled`.
    expect(SRC).toMatch(/onClick=\{locked \? undefined :/);
    expect(SRC).toMatch(/disabled=\{isAgentRunning \|\| locked\}/);
  });

  it('a locked pill explains WHY, through effortLockMessage', () => {
    expect(SRC).toMatch(/locked\s*\n?\s*\? effortLockMessage\(/);
  });

  it('cycles through the same allow-list the chord uses', () => {
    // Both the pill and `ai.effortCycle` must go through `cycleEffort(effort,
    // allowed)`; cycling into a locked level would 403 the next send.
    expect(SRC).toMatch(/setEffort\(cycleEffort\(effort, allowed\)\)/);
  });

  it('the running-state disable behavior survives', () => {
    expect(SRC).toMatch(/isAgentRunning \|\| locked/);
  });

  it('never lets colour be the only signal — the level is always named', () => {
    expect(SRC).toMatch(/\{active\.label\}/);
    expect(SRC).toMatch(/aria-label=\{`Reasoning effort: \$\{active\.label\}/);
  });
});
