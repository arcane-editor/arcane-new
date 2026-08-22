import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Source-text check, same technique as `EffortSelector.test.ts` /
// `keybinding-parity.test.ts`: this component's LABELS/TITLES maps are
// module-private consts, and there's no render harness in this codebase
// (no jsdom/testing-library) to mount the button and read its text. A
// `Record<InlineSuggestStatus, string>` already forces every status to have
// an entry at compile time (tsc fails otherwise) — this pins the exact
// COPY for the new 'upgrade-required' status per the brief.
const SRC = readFileSync(path.resolve(import.meta.dir, './InlineSuggestStatusItem.tsx'), 'utf8');

describe("InlineSuggestStatusItem — 'upgrade-required' copy", () => {
  it("pins the status-bar label", () => {
    expect(SRC).toMatch(/'upgrade-required':\s*'Tab · upgrade',/);
  });

  it('pins the tooltip title', () => {
    expect(SRC).toMatch(
      /'upgrade-required':\s*'Tab completions are available on the Starter plan and above\.',/,
    );
  });
});
