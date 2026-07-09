import { describe, it, expect } from 'bun:test';
import { renderReport } from './report';
import { aggregateAttempts } from './aggregate';
import type { TaskResult } from './eval-types';

function mkResult(taskId: string, family: string, pass: boolean, overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    taskId,
    family,
    pass,
    checks: pass ? [] : [{ spec: { type: 'file_exists', path: 'x.cs' }, pass: false, detail: 'missing: x.cs' }],
    turns: 2,
    wallMs: 1000,
    inputTokens: 100,
    outputTokens: 50,
    groundingCacheMisses: 0,
    recordFailures: 0,
    groundingLintHits: 0,
    toolCalls: [],
    ...overrides,
  };
}

describe('renderReport', () => {
  it('N=1: renders a 1/1 score column and no flakiness marker', () => {
    const results = [aggregateAttempts([mkResult('codegen-1', 'codegen', true)])];
    const report = renderReport(results, 'test-label');
    expect(report).toContain('**1/1 passed**');
    expect(report).toContain('1/1');
    expect(report).not.toContain('flaky');
    expect(report).not.toContain('repeats=');
    expect(report).toContain('| Turns | Wall (s) | Tokens in/out |');
    expect(report).not.toContain('(Σ)');
  });

  it('N=3 flaky task: shows passCount/N and a flakiness marker', () => {
    const attempts = [
      mkResult('agentic-1', 'agentic', true),
      mkResult('agentic-1', 'agentic', true),
      mkResult('agentic-1', 'agentic', false),
    ];
    const results = [aggregateAttempts(attempts)];
    const report = renderReport(results, 'test-label');
    expect(report).toContain('2/3');
    expect(report).toContain('~');
    expect(report).toContain('repeats=3');
    expect(report).toContain('flaky');
    expect(report).toContain('| Turns (Σ) | Wall (s) (Σ) | Tokens in/out (Σ) |');
  });

  it('totals row counts aggregated verdicts, not raw attempts', () => {
    // 1/3 pass: ceil(3/2) = 2, so 1 < 2 -> aggregated fail despite one passing attempt.
    const minorityFail = aggregateAttempts([
      mkResult('t1', 'codegen', true),
      mkResult('t1', 'codegen', false),
      mkResult('t1', 'codegen', false),
    ]);
    const failing = aggregateAttempts([mkResult('t2', 'codegen', false)]);
    const report = renderReport([minorityFail, failing], 'test-label');
    expect(report).toContain('**0/2 passed**');
    expect(report).toContain('- **codegen**: 0/2');
  });
});
