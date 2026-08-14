import { describe, it, expect } from 'bun:test';
import { TIER_CONTEXT_WINDOWS, coerceAgentKind } from './types';

describe('TIER_CONTEXT_WINDOWS', () => {
  // These are PRICING cliffs, not model windows. Exceeding them reprices the
  // entire request, so compaction must treat them as hard limits.
  it('encodes each tier usable window', () => {
    expect(TIER_CONTEXT_WINDOWS.low).toBe(272_000);   // luna reprices above this
    expect(TIER_CONTEXT_WINDOWS.mid).toBe(262_144);   // glm-5.2, flat pricing
    expect(TIER_CONTEXT_WINDOWS.high).toBe(200_000);  // grok-4.6 reprices above this
  });

  it('has no super tier', () => {
    expect('super' in TIER_CONTEXT_WINDOWS).toBe(false);
  });
});

describe('coerceAgentKind (persisted-session migration)', () => {
  it('passes through the live "arcane" kind', () => {
    expect(coerceAgentKind('arcane')).toBe('arcane');
  });

  it('coerces the removed "claude" kind to "arcane"', () => {
    expect(coerceAgentKind('claude')).toBe('arcane');
  });

  it('coerces any unknown / future kind to "arcane"', () => {
    expect(coerceAgentKind('gemini')).toBe('arcane');
    expect(coerceAgentKind('codex')).toBe('arcane');
  });

  it('coerces missing / non-string values to "arcane" (never crashes)', () => {
    expect(coerceAgentKind(undefined)).toBe('arcane');
    expect(coerceAgentKind(null)).toBe('arcane');
    expect(coerceAgentKind(42)).toBe('arcane');
    expect(coerceAgentKind({})).toBe('arcane');
  });
});
