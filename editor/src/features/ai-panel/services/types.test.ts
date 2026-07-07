import { describe, it, expect } from 'bun:test';
import { TIER_CONTEXT_WINDOWS } from './types';

describe('TIER_CONTEXT_WINDOWS', () => {
  it('matches the real windows of the frozen CF model lineup', () => {
    expect(TIER_CONTEXT_WINDOWS.low).toBe(32768);    // @cf/qwen/qwen2.5-coder-32b-instruct
    expect(TIER_CONTEXT_WINDOWS.mid).toBe(256000);   // @cf/moonshotai/kimi-k2.7-code
    expect(TIER_CONTEXT_WINDOWS.high).toBe(200000);  // @cf/zai-org/glm-5.2
    expect(TIER_CONTEXT_WINDOWS.super).toBe(200000); // @cf/zai-org/glm-5.2
  });
});
