// A small in-memory registry of this send's finished test runs.
//
// `unity_run_tests` records every run it actually awaited here so a LATER
// gate in the same send — the post-write console check (Task 13) — can ask
// "did a test run happen this turn" without re-plumbing test-store state into
// that gate or re-deriving it from the console stream. Pure and
// store/RPC-free by design, mirroring the other small per-send registries in
// this codebase (`markConsoleTurnStart`, `beginVerifiedPass`).

import type { TestRunCompletedPayload } from '../../../../types/unity';

let recorded: TestRunCompletedPayload[] = [];

/** Record a test run's finished summary — call once `unity_run_tests` has one. */
export function recordTestRunForConsoleCheck(summary: TestRunCompletedPayload): void {
  recorded.push(summary);
}

/** Drain and return every summary recorded since the last take/reset. */
export function takeRecordedTestRuns(): TestRunCompletedPayload[] {
  const out = recorded;
  recorded = [];
  return out;
}

/** Clear the registry. Call at the start of every send, next to `resetTurnGovernor()`. */
export function resetTestRunRegistry(): void {
  recorded = [];
}
