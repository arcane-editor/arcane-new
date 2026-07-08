/**
 * Pure `--repeats N` majority-scoring aggregation (`run-eval.ts`). Kept
 * side-effect-free and separate from `run-eval.ts`'s CLI/IO so it's directly
 * unit-testable: given N per-attempt `TaskResult`s for the same task, decide
 * one aggregated pass/fail verdict.
 *
 * Rule: a task passes iff `passCount >= ceil(N / 2)` — i.e. at least half of
 * the attempts passed (a tie at even N counts as a pass, not a fail; this is
 * "at least half", not "strict majority"). N=1 collapses to the single
 * attempt's own verdict, so `--repeats 1` (the default) is unchanged from
 * pre-`--repeats` behaviour.
 */

import type { TaskResult } from './eval-types';

export interface AggregatedTaskResult {
  taskId: string;
  family: string;
  /** Aggregated verdict: `passCount >= ceil(repeats / 2)`. */
  pass: boolean;
  passCount: number;
  repeats: number;
  /** True when attempts disagree (some passed, some failed) — a signal the
   * task's outcome for this model is unstable, independent of which way the
   * aggregated verdict landed. */
  flaky: boolean;
  attempts: TaskResult[];
}

export function aggregateAttempts(attempts: TaskResult[]): AggregatedTaskResult {
  if (attempts.length === 0) {
    throw new Error('aggregateAttempts requires at least one attempt');
  }
  const repeats = attempts.length;
  const passCount = attempts.filter((a) => a.pass).length;
  const pass = passCount >= Math.ceil(repeats / 2);
  const flaky = passCount > 0 && passCount < repeats;
  return {
    taskId: attempts[0].taskId,
    family: attempts[0].family,
    pass,
    passCount,
    repeats,
    flaky,
    attempts,
  };
}
