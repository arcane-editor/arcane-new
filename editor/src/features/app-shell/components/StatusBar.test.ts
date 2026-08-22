import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Source-text check (same technique as `EffortSelector.test.ts` /
// `keybinding-parity.test.ts`): `StatusBar.tsx` can't be rendered here (no
// jsdom/testing-library in this codebase) — it pulls in `stores/ai.ts`'s
// module graph transitively through several of the stores/features it
// imports. `usagePercent`'s math is unit-tested directly
// (`utils/usage-percent.test.ts`); this file only pins that the LOW-CREDIT
// warning was converted to a usage-percentage gate and never renders a raw
// number again.
const SRC = readFileSync(path.resolve(import.meta.dir, './StatusBar.tsx'), 'utf8');

describe('StatusBar — usage-percentage warning (no raw credits)', () => {
  it('gates on usagePercent >= 90, not a raw credit threshold', () => {
    expect(SRC).toMatch(/usedPct !== null && usedPct >= 90/);
    expect(SRC).not.toMatch(/credits\s*<\s*10/);
  });

  it('renders "AI usage {N}%", never a raw credit count', () => {
    expect(SRC).toMatch(/AI usage \{usedPct\}%/);
    expect(SRC).not.toMatch(/\{Math\.max\(0,\s*Math\.floor\(credits\)\)\}/);
    expect(SRC).not.toMatch(/\{credits\}/);
  });

  it('never renders the literal word "credits" immediately alongside an interpolated number (the binding directive) — "AI usage" copy alone is fine', () => {
    // A number token `{...}` directly adjacent to the word "credits" is what's
    // forbidden; "AI usage" mentioning credits as a bare word (no number) is not.
    expect(SRC).not.toMatch(/\{[^}]*\}\s*credits\b/);
    expect(SRC).not.toMatch(/credits\s*\{[^}]*\}/);
  });

  it('computes usedPct from usage.planBalance + planGrant, never from the raw `credits` balance field', () => {
    expect(SRC).toMatch(/usagePercent\(planGrant,\s*usage\.planBalance\)/);
  });
});
