import { describe, it, expect } from 'bun:test';
import { TIER_CONTEXT_WINDOWS, coerceAgentKind } from './types';

describe('TIER_CONTEXT_WINDOWS', () => {
  it('matches the real windows of the frozen CF model lineup', () => {
    expect(TIER_CONTEXT_WINDOWS.low).toBe(32768);    // @cf/qwen/qwen2.5-coder-32b-instruct
    expect(TIER_CONTEXT_WINDOWS.mid).toBe(256000);   // @cf/moonshotai/kimi-k2.7-code
    expect(TIER_CONTEXT_WINDOWS.high).toBe(200000);  // @cf/zai-org/glm-5.2
    expect(TIER_CONTEXT_WINDOWS.super).toBe(200000); // @cf/zai-org/glm-5.2
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
