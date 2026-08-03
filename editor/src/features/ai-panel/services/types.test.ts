import { describe, it, expect } from 'bun:test';
import { TIER_CONTEXT_WINDOWS, coerceAgentKind } from './types';

describe('TIER_CONTEXT_WINDOWS', () => {
  it('matches min(primary, fallback) for each tier\'s model lineup', () => {
    expect(TIER_CONTEXT_WINDOWS.low).toBe(32768);    // min(MiniMax-M3 200k, qwen2.5-coder fallback 32k)
    expect(TIER_CONTEXT_WINDOWS.mid).toBe(200000);   // glm-5.2, no fallback
    expect(TIER_CONTEXT_WINDOWS.high).toBe(200000);  // min(kimi-k3 256k, glm-5.2 fallback 200k)
    expect(TIER_CONTEXT_WINDOWS.super).toBe(200000); // alias of high
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
