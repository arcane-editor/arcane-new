import { describe, it, expect } from 'bun:test';
import { aggregateAttempts } from './aggregate';
import type { TaskResult } from './eval-types';

function mkResult(pass: boolean): TaskResult {
  return {
    taskId: 'task-1',
    family: 'codegen',
    pass,
    checks: [],
    turns: 1,
    wallMs: 10,
    inputTokens: 0,
    outputTokens: 0,
    groundingCacheMisses: 0,
    recordFailures: 0,
    toolCalls: [],
  };
}

describe('aggregateAttempts', () => {
  it('N=1 pass: aggregated verdict matches the single attempt, not flaky', () => {
    const agg = aggregateAttempts([mkResult(true)]);
    expect(agg.pass).toBe(true);
    expect(agg.passCount).toBe(1);
    expect(agg.repeats).toBe(1);
    expect(agg.flaky).toBe(false);
    expect(agg.attempts).toHaveLength(1);
  });

  it('N=1 fail: aggregated verdict matches the single attempt, not flaky', () => {
    const agg = aggregateAttempts([mkResult(false)]);
    expect(agg.pass).toBe(false);
    expect(agg.passCount).toBe(0);
    expect(agg.flaky).toBe(false);
  });

  it('N=3, 2/3 pass: aggregated pass (majority), flagged flaky', () => {
    const agg = aggregateAttempts([mkResult(true), mkResult(true), mkResult(false)]);
    expect(agg.passCount).toBe(2);
    expect(agg.repeats).toBe(3);
    expect(agg.pass).toBe(true);
    expect(agg.flaky).toBe(true);
  });

  it('N=3, 1/3 pass: aggregated fail (minority), flagged flaky', () => {
    const agg = aggregateAttempts([mkResult(true), mkResult(false), mkResult(false)]);
    expect(agg.passCount).toBe(1);
    expect(agg.pass).toBe(false);
    expect(agg.flaky).toBe(true);
  });

  it('N=3, 0/3 pass (all-fail): aggregated fail, not flaky (attempts agree)', () => {
    const agg = aggregateAttempts([mkResult(false), mkResult(false), mkResult(false)]);
    expect(agg.passCount).toBe(0);
    expect(agg.pass).toBe(false);
    expect(agg.flaky).toBe(false);
  });

  it('N=3, 3/3 pass (all-pass): aggregated pass, not flaky', () => {
    const agg = aggregateAttempts([mkResult(true), mkResult(true), mkResult(true)]);
    expect(agg.passCount).toBe(3);
    expect(agg.pass).toBe(true);
    expect(agg.flaky).toBe(false);
  });

  it('ceil boundary N=4, 2/4 pass: exactly half passes (ceil(4/2) = 2), aggregated pass', () => {
    const agg = aggregateAttempts([mkResult(true), mkResult(true), mkResult(false), mkResult(false)]);
    expect(agg.passCount).toBe(2);
    expect(agg.repeats).toBe(4);
    expect(agg.pass).toBe(true);
    expect(agg.flaky).toBe(true);
  });

  it('ceil boundary N=4, 1/4 pass: below half, aggregated fail', () => {
    const agg = aggregateAttempts([mkResult(true), mkResult(false), mkResult(false), mkResult(false)]);
    expect(agg.passCount).toBe(1);
    expect(agg.pass).toBe(false);
  });

  it('throws on an empty attempts array', () => {
    expect(() => aggregateAttempts([])).toThrow();
  });
});
