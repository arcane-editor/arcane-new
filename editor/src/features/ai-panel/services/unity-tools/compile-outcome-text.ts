// compile-outcome-text.ts — pure prose for a `CompileWaitOutcome`, extracted
// out of `compile-gate.ts` so the exact wording the gate has always shown the
// model is reusable elsewhere without duplicating it: `get_compile_errors`
// (this task) needs the same honest "what happened" text when it triggers a
// recompile itself, and Task 13 consumes it too.
//
// Deliberately does NOT include the `[Unity compile]` marker `compile-gate.ts`
// prepends — callers own their own framing. `get_compile_errors`'s output must
// not start with that marker at all (it is not a write-tool decorator note).
//
// Byte-pinned against the strings `compile-gate.ts` shipped before this file
// existed — see `compile-outcome-text.test.ts` — so this extraction changes
// nothing about what the model already reads.

import type { CompileWaitOutcome } from '../../../unity-bridge';

/**
 * Render the non-error-report branches of a `CompileWaitOutcome` as the prose
 * the compile gate has always used. Returns `''` for two cases a caller must
 * handle itself:
 *   - `{status:'report'}` with compiler errors present — the caller formats
 *     the actual `file:line: message` list (and any de-hallucination hints);
 *     this function only covers the CLEAN report case (`{status:'report'}`
 *     with zero errors, which is worded exactly like the rest).
 *   - `{status:'unknown', reason:'aborted'}` — the gate treats an aborted
 *     turn as "say nothing" (the write already returned its own result;
 *     there is no compile outcome to report on).
 */
export function describeCompileOutcome(outcome: CompileWaitOutcome): string {
  if (outcome.status === 'report') {
    const errors = (outcome.report.messages ?? []).filter((m) => m.type === 'Error');
    return errors.length === 0 ? 'Clean — no compiler errors.' : '';
  }

  if (outcome.status === 'no-compile') {
    return 'Assets refreshed — no recompile was needed.';
  }

  // status === 'unknown'
  if (outcome.reason === 'aborted') return '';

  if (outcome.reason === 'editor-asleep') {
    // Whether waiting can possibly help is the difference between these two
    // tails, so they must not be collapsed. With no focus-free wake available
    // (Linux, or a P/Invoke that latched off), the compile genuinely will not
    // happen until a human focuses Unity, and telling the model to sit tight
    // would be telling it to wait forever.
    const tail =
      outcome.canWake === false
        ? `This build of the bridge cannot wake Unity without focus, so the compile ` +
          `will not run until someone focuses the Unity window.`
        : `The import is queued and runs as soon as Unity ticks — compiler errors, ` +
          `if any, arrive then.`;
    return (
      `Unity's window is in the background, so its editor loop is ` +
      `parked and it has not reported a compile for this change. ${tail} ` +
      `This is NOT a failure: the write succeeded — continue with the remaining file ` +
      `work. Do not rewrite the file to try to force a compile.`
    );
  }

  const why =
    outcome.reason === 'bridge-lost'
      ? 'Unity bridge was lost mid-compile; it reconnects automatically after the reload'
      : "timed out waiting for Unity's report";
  return (
    `Compile status unknown (${why}). ` +
    `This is NOT a failure: the write succeeded — continue with the remaining file work, ` +
    `and verify before finishing the task.`
  );
}
