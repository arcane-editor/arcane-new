// A small in-memory registry of this send's test runs.
//
// `unity_run_tests` records every run it actually awaited here so a LATER
// gate in the same send — the post-write console check (Task 13) — can ask
// "did a test run happen this turn" without re-plumbing test-store state into
// that gate or re-deriving it from the console stream. Pure and
// store/RPC-free by design, mirroring the other small per-send registries in
// this codebase (`markConsoleTurnStart`, `beginVerifiedPass`).
//
// TWO registers, drained separately (R11). A finished run goes in `recorded`
// and becomes the card's counts. A run that never produced a result — Unity
// parked in the background, the bridge lost, the Test Framework missing —
// goes in `attempts` instead. Keeping them apart is the point: the console
// check's `collectNewProblems` must still see ZERO runs for an attempt (there
// are no failures to fold in), while the Verified card must still be rendered
// and must say the run did not finish. Before this split, a turn whose only
// action was `unity_run_tests` against a backgrounded Unity emitted no card
// at all.

import type { TestRunCompletedPayload } from '../../../../types/unity';

/**
 * A `unity_run_tests` call that did not come back with a result.
 *
 * `reason` is the wait outcome's own reason token (`TestRunWaitOutcome`'s
 * `reason`, or the `ok:false` summary's), carried verbatim so the row copy —
 * not this registry — decides how to word it.
 */
export interface TestRunAttempt {
  status: 'unknown';
  reason: string;
}

let recorded: TestRunCompletedPayload[] = [];
let attempts: TestRunAttempt[] = [];

/** Record a test run's finished summary — call once `unity_run_tests` has one. */
export function recordTestRunForConsoleCheck(summary: TestRunCompletedPayload): void {
  recorded.push(summary);
}

/** Record a run that was asked for but never reported — see `TestRunAttempt`. */
export function recordTestRunAttempt(attempt: TestRunAttempt): void {
  attempts.push(attempt);
}

/** Drain and return every summary recorded since the last take/reset. */
export function takeRecordedTestRuns(): TestRunCompletedPayload[] {
  const out = recorded;
  recorded = [];
  return out;
}

/** Drain and return every unfinished attempt recorded since the last take/reset. */
export function takeRecordedTestRunAttempts(): TestRunAttempt[] {
  const out = attempts;
  attempts = [];
  return out;
}

/** Clear the registry (both registers). Call at the start of every send, next to `resetTurnGovernor()`. */
export function resetTestRunRegistry(): void {
  recorded = [];
  attempts = [];
}
