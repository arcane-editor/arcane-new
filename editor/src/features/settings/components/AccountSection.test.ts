import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Source-text check (same technique as `EffortSelector.test.ts` /
// `keybinding-parity.test.ts`): this component can't be rendered here (no
// jsdom/testing-library in this codebase, and `stores/auth.ts` is not
// import-safe under plain `bun test` — see `AI_STORE_SRC`'s note in
// `session-persistence.test.ts` for the same class of constraint).
// `usagePercent`'s math is unit-tested directly (`utils/usage-percent.test.ts`);
// this file pins that the raw "Credits left" field was fully replaced.
const SRC = readFileSync(path.resolve(import.meta.dir, './AccountSection.tsx'), 'utf8');

describe('AccountSection — usage percentage (no raw credits)', () => {
  it('no longer renders the raw credit balance', () => {
    expect(SRC).not.toMatch(/Credits left/);
    expect(SRC).not.toMatch(/Math\.round\(credits\)/);
    expect(SRC).not.toMatch(/\{credits\}/);
  });

  it('renders "N% of monthly AI usage used", or "AI trial N% used" on the free plan', () => {
    expect(SRC).toMatch(/`\$\{usedPct\}% of monthly AI usage used`/);
    expect(SRC).toMatch(/`AI trial \$\{usedPct\}% used`/);
    expect(SRC).toMatch(/plan === 'free'/);
  });

  it('falls back to "—" when the percentage cannot be computed, same as the old raw-balance placeholder', () => {
    expect(SRC).toMatch(/usedPct === null\s*\n?\s*\?\s*'—'/);
  });

  it('adds a muted, NUMBER-FREE "extra usage available" line only when a top-up balance exists', () => {
    expect(SRC).toMatch(/usage\.topupBalance > 0/);
    expect(SRC).toMatch(/Extra usage available/);
    // The note must never carry a number of its own.
    expect(SRC).not.toMatch(/Extra usage available[^<]*\{/);
  });

  it('never renders the literal word "credits" immediately alongside an interpolated number (the binding directive)', () => {
    expect(SRC).not.toMatch(/\{[^}]*\}\s*credits\b/);
    expect(SRC).not.toMatch(/credits\s*\{[^}]*\}/);
  });

  it('the Plan label line stays', () => {
    expect(SRC).toMatch(/Plan<\/div>/);
    expect(SRC).toMatch(/\{plan \?\? 'Free'\}/);
  });
});
