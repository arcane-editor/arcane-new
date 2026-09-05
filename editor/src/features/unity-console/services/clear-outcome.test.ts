import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describeClearOutcome } from './clear-outcome';

describe('describeClearOutcome', () => {
  it('says nothing when Unity\'s console really was cleared — the empty panel is the confirmation', () => {
    expect(describeClearOutcome({ clearedUnity: true })).toBeNull();
  });

  it('relays the store\'s reason verbatim when it was not', () => {
    expect(
      describeClearOutcome({
        clearedUnity: false,
        unityReason: "Unity's console was not cleared: the bridge is not connected.",
      }),
    ).toBe("Unity's console was not cleared: the bridge is not connected.");
  });

  it('still says the console was not cleared when no reason came back', () => {
    // The failure is the fact that matters; a missing reason must not turn
    // into silence, which is exactly how the panel used to read as success.
    expect(describeClearOutcome({ clearedUnity: false })).toBe(
      "Unity's console was not cleared.",
    );
  });
});

// `UnityConsolePanel.tsx` is a React component reaching Monaco-adjacent stores
// and `document`, so it cannot be imported under Bun (Global Constraint 4).
// The one thing that matters here — that it awaits the outcome instead of
// throwing it away — is pinned by source text (Global Constraint 14).
const PANEL_SRC = readFileSync(
  path.resolve(import.meta.dir, '../components/UnityConsolePanel.tsx'),
  'utf8',
);

describe('UnityConsolePanel — "Clear here and in Unity" wiring', () => {
  it('consumes the clear outcome rather than discarding it', () => {
    expect(PANEL_SRC).toContain("void clearLogs({ unity: true }).then((outcome) => {");
    expect(PANEL_SRC).toContain('setClearNotice(describeClearOutcome(outcome));');
    // The fire-and-forget call this replaced.
    expect(PANEL_SRC).not.toContain('void clearLogs({ unity: true });');
  });

  it('renders the notice', () => {
    expect(PANEL_SRC).toContain('{clearNotice && (');
    expect(PANEL_SRC).toContain('<span>{clearNotice}</span>');
  });
});
