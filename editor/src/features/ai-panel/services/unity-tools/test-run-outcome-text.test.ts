import { describe, it, expect } from 'bun:test';
import { describeTestRunOutcome } from './test-run-outcome-text';
import type { TestRunWaitOutcome } from '../../../unity-test-runner';
import type { TestRunFailure } from '../../../../types/unity';

/** Unity's real "(at File.cs:line)" shape — the only thing `parseStackTrace` recognizes. */
function frameLine(className: string, method: string, file: string, line: number): string {
  return `${className}.${method} () (at ${file}:${line})`;
}

function failure(overrides: Partial<TestRunFailure> = {}): TestRunFailure {
  return {
    fullName: 'Foo.Bar.Test1',
    status: 'Failed',
    message: 'Expected 1 but was 2',
    stackTrace:
      frameLine('Foo.Bar', 'Test1', 'Assets/Tests/FooTests.cs', 42) +
      '\n' +
      frameLine('UnityEngine.TestRunner', 'SomeInternal', 'Packages/com.unity.test-framework/Internal.cs', 1),
    durationMs: 12,
    ...overrides,
  };
}

describe('describeTestRunOutcome', () => {
  it('formats a clean run as the verbatim summary line', () => {
    const text = describeTestRunOutcome({
      status: 'report',
      summary: {
        runId: 'r1',
        ok: true,
        mode: 'EditMode',
        total: 12,
        passed: 12,
        failed: 0,
        skipped: 0,
        durationMs: 4100,
      },
    });
    expect(text).toBe('EditMode tests: 12 passed, 0 failed, 0 skipped (4.1s)');
  });

  it('matches the brief-specified summary line for a mixed run', () => {
    const text = describeTestRunOutcome({
      status: 'report',
      summary: {
        runId: 'r1',
        ok: true,
        mode: 'EditMode',
        total: 14,
        passed: 12,
        failed: 2,
        skipped: 0,
        durationMs: 4100,
      },
    });
    expect(text.split('\n')[0]).toBe('EditMode tests: 12 passed, 2 failed, 0 skipped (4.1s)');
  });

  it('lists each failure with fullName, message and project stack frames', () => {
    const text = describeTestRunOutcome({
      status: 'report',
      summary: {
        runId: 'r1',
        ok: true,
        mode: 'EditMode',
        total: 1,
        passed: 0,
        failed: 1,
        skipped: 0,
        durationMs: 100,
        failures: [failure()],
        failuresTruncated: false,
      },
    });
    expect(text).toContain('FAILED Foo.Bar.Test1');
    expect(text).toContain('Expected 1 but was 2');
    expect(text).toContain('Assets/Tests/FooTests.cs:42');
    // Package/engine frames are not project frames and must not appear.
    expect(text).not.toContain('Packages/com.unity.test-framework');
  });

  it('caps a failure message at 600 chars', () => {
    const longMessage = 'x'.repeat(900);
    const text = describeTestRunOutcome({
      status: 'report',
      summary: {
        runId: 'r1',
        ok: true,
        mode: 'EditMode',
        total: 1,
        passed: 0,
        failed: 1,
        skipped: 0,
        failures: [failure({ message: longMessage })],
      },
    });
    const messageLine = text.split('\n').find((l) => l.trim().startsWith('x'));
    expect(messageLine).toBeDefined();
    // 600 chars of 'x' plus the truncation ellipsis, plus leading indentation.
    expect((messageLine ?? '').trim().length).toBe(601);
  });

  it('shows only the first 3 project frames per failure', () => {
    const manyFrames = Array.from({ length: 5 }, (_, i) =>
      frameLine('Foo', `Method${i}`, `Assets/Foo${i}.cs`, i),
    ).join('\n');
    const text = describeTestRunOutcome({
      status: 'report',
      summary: {
        runId: 'r1',
        ok: true,
        mode: 'EditMode',
        total: 1,
        passed: 0,
        failed: 1,
        skipped: 0,
        failures: [failure({ stackTrace: manyFrames })],
      },
    });
    expect(text).toContain('Foo2.cs:2');
    expect(text).not.toContain('Foo3.cs:3');
    expect(text).not.toContain('Foo4.cs:4');
  });

  it('notes truncation when the run reported more failures than were kept', () => {
    const text = describeTestRunOutcome({
      status: 'report',
      summary: {
        runId: 'r1',
        ok: true,
        mode: 'EditMode',
        total: 60,
        passed: 0,
        failed: 60,
        skipped: 0,
        failures: [failure()],
        failuresTruncated: true,
      },
    });
    expect(text).toContain('…and 59 more failures not shown.');
  });

  it('ok:false / test-framework-missing', () => {
    const text = describeTestRunOutcome({
      status: 'report',
      summary: { runId: null, ok: false, reason: 'test-framework-missing' },
    });
    expect(text).toContain("Unity's Test Framework is not available");
  });

  it('ok:false / runner-unavailable', () => {
    const text = describeTestRunOutcome({
      status: 'report',
      summary: { runId: null, ok: false, reason: 'runner-unavailable' },
    });
    expect(text).toContain("Unity's test runner could not start this run");
  });

  it('unknown/editor-asleep — the verbatim degraded copy', () => {
    const outcome: TestRunWaitOutcome = { status: 'unknown', reason: 'editor-asleep' };
    expect(describeTestRunOutcome(outcome)).toBe(
      "Test run accepted, but Unity's window is in the background so it has not started; " +
        'results appear in the Test panel when it ticks.',
    );
  });

  it('unknown/nothing-matched — reported honestly, not as success', () => {
    const text = describeTestRunOutcome({ status: 'unknown', reason: 'nothing-matched' });
    expect(text.toLowerCase()).toContain('no tests');
    expect(text.toLowerCase()).not.toContain('passed');
  });

  it('unknown/not-installed', () => {
    const text = describeTestRunOutcome({ status: 'unknown', reason: 'not-installed' });
    expect(text).toContain("Unity's Test Framework is not installed");
  });

  it('unknown/timeout', () => {
    const text = describeTestRunOutcome({ status: 'unknown', reason: 'timeout' });
    expect(text).toContain('timed out');
  });

  it('unknown/bridge-lost', () => {
    const text = describeTestRunOutcome({ status: 'unknown', reason: 'bridge-lost' });
    expect(text).toContain('bridge disconnected');
  });

  it('unknown/aborted', () => {
    const text = describeTestRunOutcome({ status: 'unknown', reason: 'aborted' });
    expect(text).toBe('Test run cancelled before it finished.');
  });
});
