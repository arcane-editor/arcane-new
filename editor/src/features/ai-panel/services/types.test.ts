import { describe, it, expect } from 'bun:test';
import { TIER_CONTEXT_WINDOWS, coerceAgentKind, coerceEffort, isExternalAgent } from './types';

describe('TIER_CONTEXT_WINDOWS', () => {
  // Offline fallback only — mirrors /v1/config's per-tier contextWindow
  // (min across planner/executor/executorHard). All three sit at spark's
  // conservative 131k seed window today.
  it('encodes each tier usable window', () => {
    expect(TIER_CONTEXT_WINDOWS.low).toBe(131_072);
    expect(TIER_CONTEXT_WINDOWS.mid).toBe(131_072);
    expect(TIER_CONTEXT_WINDOWS.high).toBe(131_072);
  });

  it('has no super tier', () => {
    expect('super' in TIER_CONTEXT_WINDOWS).toBe(false);
  });
});

describe('coerceAgentKind (persisted-session migration)', () => {
  it('passes through the live "arcane" kind', () => {
    expect(coerceAgentKind('arcane')).toBe('arcane');
  });

  it('round-trips the "claude" kind now that external agents are back', () => {
    expect(coerceAgentKind('claude')).toBe('claude');
  });

  it('restores a Claude transcript regardless of entitlement', () => {
    // Guards a tempting shortcut: coercing 'claude' -> 'arcane' for free-plan
    // users would silently relabel whose turns those were. The gate belongs on
    // the composer, not on history.
    expect(coerceAgentKind('claude')).toBe('claude');
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

describe('isExternalAgent', () => {
  it('is false for the hosted agent and true for everything else', () => {
    expect(isExternalAgent('arcane')).toBe(false);
    expect(isExternalAgent('claude')).toBe(true);
  });
});

describe('coerceEffort (persisted-session migration)', () => {
  it('passes through every live tier', () => {
    expect(coerceEffort('low')).toBe('low');
    expect(coerceEffort('mid')).toBe('mid');
    expect(coerceEffort('high')).toBe('high');
  });

  it('coerces the removed "super" tier to "low"', () => {
    expect(coerceEffort('super')).toBe('low');
  });

  it('coerces any unknown / future level to "low"', () => {
    expect(coerceEffort('max')).toBe('low');
    expect(coerceEffort('ultra')).toBe('low');
  });

  it('coerces missing / non-string values to "low" (never crashes)', () => {
    expect(coerceEffort(undefined)).toBe('low');
    expect(coerceEffort(null)).toBe('low');
    expect(coerceEffort(42)).toBe('low');
    expect(coerceEffort({})).toBe('low');
  });
});
