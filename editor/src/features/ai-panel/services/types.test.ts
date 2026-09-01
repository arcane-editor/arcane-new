import { describe, it, expect } from 'bun:test';
import { TIER_CONTEXT_WINDOWS, coerceAgentKind, coerceEffort, isExternalAgent } from './types';

describe('TIER_CONTEXT_WINDOWS', () => {
  // Offline fallback only — mirrors /v1/config's per-tier contextWindow
  // (min across planner/executor/executorHard). glm-5.3-flash's 1,048,576
  // replaced spark's conservative 131k executor seed on 2026-08-27, and
  // glm-5.3 replaced grok's 500,000 mid planner on 2026-08-30 — leaving
  // gpt-5.6-sol on the high tier as the only model still binding a window.
  it('encodes each tier usable window', () => {
    expect(TIER_CONTEXT_WINDOWS.low).toBe(1_048_576);
    expect(TIER_CONTEXT_WINDOWS.mid).toBe(1_048_576);
    expect(TIER_CONTEXT_WINDOWS.high).toBe(400_000);
  });

  // Low and mid share the whole GLM-5.3 family window; only the high tier's
  // gpt-5.6-sol planner narrows it. A routing change that silently drops a
  // tier's usable context is worth failing on — under-compacting builds
  // requests the provider rejects outright.
  it('is bounded tightest at the top, where the planner is smallest', () => {
    expect(TIER_CONTEXT_WINDOWS.low).toBe(TIER_CONTEXT_WINDOWS.mid);
    expect(TIER_CONTEXT_WINDOWS.mid).toBeGreaterThan(TIER_CONTEXT_WINDOWS.high);
  });

  it('has no super tier', () => {
    expect('super' in TIER_CONTEXT_WINDOWS).toBe(false);
  });
});

describe('coerceAgentKind (persisted-session migration)', () => {
  it('passes through the live "hosted" kind', () => {
    expect(coerceAgentKind('hosted')).toBe('hosted');
  });

  it('round-trips the "claude" kind now that external agents are back', () => {
    expect(coerceAgentKind('claude')).toBe('claude');
  });

  it('restores a Claude transcript regardless of entitlement', () => {
    // Guards a tempting shortcut: coercing 'claude' -> 'hosted' for free-plan
    // users would silently relabel whose turns those were. The gate belongs on
    // the composer, not on history.
    expect(coerceAgentKind('claude')).toBe('claude');
  });

  /**
   * The pre-rename spelling of the hosted kind, sitting in every session file
   * written before this release. It needs no dedicated migration BECAUSE the
   * unknown-value fallback lands on exactly the right answer — those sessions
   * really were the hosted agent — but that is a coincidence worth pinning, so
   * a future change to the fallback cannot silently relabel old transcripts.
   */
  it('restores a pre-rename "arcane" session as the hosted agent', () => {
    expect(coerceAgentKind('arcane')).toBe('hosted');
  });

  it('coerces any unknown / future kind to "hosted"', () => {
    expect(coerceAgentKind('gemini')).toBe('hosted');
    expect(coerceAgentKind('codex')).toBe('hosted');
  });

  it('coerces missing / non-string values to "hosted" (never crashes)', () => {
    expect(coerceAgentKind(undefined)).toBe('hosted');
    expect(coerceAgentKind(null)).toBe('hosted');
    expect(coerceAgentKind(42)).toBe('hosted');
    expect(coerceAgentKind({})).toBe('hosted');
  });
});

describe('isExternalAgent', () => {
  it('is false for the hosted agent and true for everything else', () => {
    expect(isExternalAgent('hosted')).toBe(false);
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
