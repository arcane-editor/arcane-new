import { describe, it, expect, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  recordTestRunForConsoleCheck,
  recordTestRunAttempt,
  takeRecordedTestRuns,
  takeRecordedTestRunAttempts,
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

// R11. An attempt is a run that was ASKED FOR and never came back. It has to
// be tracked apart from a finished run: the console check counts runs (an
// attempt contributes no failures and must not look like one), while the
// Verified card has to be rendered anyway and has to say the run did not
// finish.
describe('test-run-registry — unfinished attempts', () => {
  afterEach(() => {
    resetTestRunRegistry();
  });

  it('starts empty', () => {
    expect(takeRecordedTestRunAttempts()).toEqual([]);
  });

  it('returns recorded attempts in order', () => {
    recordTestRunAttempt({ status: 'unknown', reason: 'editor-asleep' });
    recordTestRunAttempt({ status: 'unknown', reason: 'bridge-lost' });
    expect(takeRecordedTestRunAttempts()).toEqual([
      { status: 'unknown', reason: 'editor-asleep' },
      { status: 'unknown', reason: 'bridge-lost' },
    ]);
  });

  it('take drains the attempts — a second take is empty', () => {
    recordTestRunAttempt({ status: 'unknown', reason: 'timeout' });
    takeRecordedTestRunAttempts();
    expect(takeRecordedTestRunAttempts()).toEqual([]);
  });

  it('keeps the two registers apart — an attempt is never returned as a run', () => {
    recordTestRunAttempt({ status: 'unknown', reason: 'editor-asleep' });
    expect(takeRecordedTestRuns()).toEqual([]);
    expect(takeRecordedTestRunAttempts()).toEqual([
      { status: 'unknown', reason: 'editor-asleep' },
    ]);
  });

  it('draining runs leaves the attempts alone, and vice versa', () => {
    recordTestRunForConsoleCheck(summary('a'));
    recordTestRunAttempt({ status: 'unknown', reason: 'timeout' });

    expect(takeRecordedTestRuns()).toEqual([summary('a')]);
    expect(takeRecordedTestRunAttempts()).toEqual([{ status: 'unknown', reason: 'timeout' }]);
  });

  it('reset clears BOTH registers without returning either', () => {
    recordTestRunForConsoleCheck(summary('a'));
    recordTestRunAttempt({ status: 'unknown', reason: 'editor-asleep' });

    resetTestRunRegistry();

    expect(takeRecordedTestRuns()).toEqual([]);
    expect(takeRecordedTestRunAttempts()).toEqual([]);
  });
});


// `mutate-tools.ts` statically imports `stores/unity`/`stores/settings`, both
// DOM-bound and unimportable under Bun (Global Constraint 4), so its wiring is
// pinned by source text — the same technique `agent-service-wiring.test.ts`
// documents.
const MUTATE_SRC = readFileSync(path.resolve(import.meta.dir, './mutate-tools.ts'), 'utf8');

describe('mutate-tools.ts — unity_run_tests wiring (R11)', () => {
  it('imports both recorders from the registry', () => {
    expect(MUTATE_SRC).toContain(
      "import { recordTestRunForConsoleCheck, recordTestRunAttempt } from './test-run-registry';",
    );
  });

  it('records a RUN only for an ok:true report, and an ATTEMPT for every other outcome', () => {
    const match = MUTATE_SRC.match(
      /if \(outcome\.status === 'report' && outcome\.summary\.ok\) \{([\s\S]*?)\} else \{([\s\S]*?)\n        \}/,
    );
    expect(match).not.toBeNull();
    expect(match![1]).toContain('recordTestRunForConsoleCheck(outcome.summary)');
    expect(match![2]).toContain('recordTestRunAttempt(');
    expect(match![2]).toContain("status: 'unknown'");
    // The reason carried verbatim: the ok:false summary's, or the wait
    // outcome's own token.
    expect(match![2]).toContain('outcome.summary.reason');
    expect(match![2]).toContain('outcome.reason');
  });
});
