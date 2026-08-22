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

describe('EffortSelector — plan-gated bars (fail-closed)', () => {
  it('derives the allowed set from server-config + auth plan (never a hardcoded ladder)', () => {
    expect(SRC).toMatch(/allowed\s*=\s*allowedEfforts\(config,\s*plan\)/);
    expect(SRC).toMatch(/useServerConfigStore\(\(s\)\s*=>\s*s\.config\)/);
    expect(SRC).toMatch(/useAuthStore\(\(s\)\s*=>\s*s\.plan\)/);
  });

  it('a locked bar gets aria-disabled, no click handler, and stays disabled', () => {
    expect(SRC).toMatch(/const locked = !allowed\.includes\(lvl\.value\)/);
    expect(SRC).toMatch(/aria-disabled=\{locked \|\| undefined\}/);
    expect(SRC).toMatch(/onClick=\{locked \? undefined : \(\) => setEffort\(lvl\.value\)\}/);
    expect(SRC).toMatch(/disabled=\{isAgentRunning \|\| locked\}/);
  });

  it('a locked bar surfaces effortLockMessage as both its tooltip and its accessible name', () => {
    expect(SRC).toMatch(/const lockMessage = locked \? effortLockMessage\(lvl\.value\) : null/);
    expect(SRC).toMatch(/title=\{lockMessage \|\| undefined\}/);
    expect(SRC).toMatch(/aria-label=\{lockMessage \|\| `\$\{lvl\.label\} reasoning`\}/);
  });

  it('the running-state disable behavior survives (agent running still disables every bar)', () => {
    expect(SRC).toMatch(/isAgentRunning \|\| locked/);
  });
});
