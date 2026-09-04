import { describe, it, expect, afterEach } from 'bun:test';
import {
  recordTestRunForConsoleCheck,
  takeRecordedTestRuns,
  resetTestRunRegistry,
} from './test-run-registry';
import type { TestRunCompletedPayload } from '../../../../types/unity';

function summary(runId: string): TestRunCompletedPayload {
  return { runId, ok: true, mode: 'EditMode', total: 1, passed: 1, failed: 0, skipped: 0 };
}

describe('test-run-registry', () => {
  afterEach(() => {
    resetTestRunRegistry();
  });

  it('starts empty', () => {
    expect(takeRecordedTestRuns()).toEqual([]);
  });

  it('returns recorded summaries in order', () => {
    recordTestRunForConsoleCheck(summary('a'));
    recordTestRunForConsoleCheck(summary('b'));
    expect(takeRecordedTestRuns()).toEqual([summary('a'), summary('b')]);
  });

  it('take drains the registry — a second take is empty', () => {
    recordTestRunForConsoleCheck(summary('a'));
    takeRecordedTestRuns();
    expect(takeRecordedTestRuns()).toEqual([]);
  });

  it('reset clears pending recordings without returning them', () => {
    recordTestRunForConsoleCheck(summary('a'));
    resetTestRunRegistry();
    expect(takeRecordedTestRuns()).toEqual([]);
  });

  it('recordings after a take start a fresh batch', () => {
    recordTestRunForConsoleCheck(summary('a'));
    takeRecordedTestRuns();
    recordTestRunForConsoleCheck(summary('b'));
    expect(takeRecordedTestRuns()).toEqual([summary('b')]);
  });
});
