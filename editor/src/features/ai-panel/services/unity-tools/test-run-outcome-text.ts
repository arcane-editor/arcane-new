// test-run-outcome-text.ts — pure prose for a `TestRunWaitOutcome`, extracted
// out of `mutate-tools.ts`'s `unity_run_tests` the same way
// `compile-outcome-text.ts` was extracted out of `compile-gate.ts`: reusable
// without duplicating the exact wording, and directly Bun-testable.
//
// No degraded path reads as success (Global Constraint 2) — every branch here
// says plainly what is and is not known, and the caller never has to guess
// whether a run actually happened from an empty or ambiguous string.

import type { TestRunWaitOutcome } from '../../../unity-test-runner';
import type { TestRunFailure } from '../../../../types/unity';
import { parseStackTrace } from '../../../../types/unity';

/** Cap on a single failure's message — long assertion dumps blow the context otherwise. */
const MAX_MESSAGE_LEN = 600;
/** Project frames shown per failure — enough to locate it, not the whole trace. */
const MAX_FRAMES = 3;

function formatDurationS(durationMs: number | undefined): string {
  return ((durationMs ?? 0) / 1000).toFixed(1);
}

function capMessage(message: string): string {
  return message.length > MAX_MESSAGE_LEN ? message.slice(0, MAX_MESSAGE_LEN) + '…' : message;
}

/** First N stack frames inside the project (`Assets/`) — engine/package frames add nothing actionable. */
function projectFrames(stackTrace: string, max: number): string[] {
  return parseStackTrace(stackTrace)
    .filter((f) => f.filePath.startsWith('Assets/'))
    .slice(0, max)
    .map((f) => `  at ${f.className}.${f.methodName} (${f.filePath}:${f.lineNumber})`);
}

function formatFailure(f: TestRunFailure): string {
  const lines = [`FAILED ${f.fullName}`];
  const message = capMessage(f.message ?? '');
  if (message) lines.push(`  ${message}`);
  lines.push(...projectFrames(f.stackTrace ?? '', MAX_FRAMES));
  return lines.join('\n');
}

/** Render a successful (`ok: true`) completed run — the summary line plus every capped failure. */
function describeCompletedRun(summary: {
  mode?: string;
  passed?: number;
  failed?: number;
  skipped?: number;
  durationMs?: number;
  failures?: TestRunFailure[];
  failuresTruncated?: boolean;
}): string {
  const mode = summary.mode ?? 'EditMode';
  const passed = summary.passed ?? 0;
  const failed = summary.failed ?? 0;
  const skipped = summary.skipped ?? 0;
  const summaryLine = `${mode} tests: ${passed} passed, ${failed} failed, ${skipped} skipped (${formatDurationS(summary.durationMs)}s)`;

  const failures = summary.failures ?? [];
  if (failures.length === 0) return summaryLine;

  const blocks = failures.map(formatFailure);
  const tail =
    summary.failuresTruncated && failed > failures.length
      ? `\n…and ${failed - failures.length} more failures not shown.`
      : '';
  return `${summaryLine}\n\n${blocks.join('\n\n')}${tail}`;
}

/** Render a `TestRunWaitOutcome` as the text `unity_run_tests` returns to the model. */
export function describeTestRunOutcome(outcome: TestRunWaitOutcome): string {
  if (outcome.status === 'report') {
    const { summary } = outcome;
    if (summary.ok) return describeCompletedRun(summary);

    // ok:false — the run never produced a result; say which of the two
    // reasons Unity gave, not a generic failure.
    return summary.reason === 'runner-unavailable'
      ? "Unity's test runner could not start this run (it may already be running another one, " +
          'or the run failed to launch). Retry once any other run has finished.'
      : "Unity's Test Framework is not available in this project — install " +
          '`com.unity.test-framework` (or check it compiled) to run tests.';
  }

  // status === 'unknown'
  switch (outcome.reason) {
    case 'aborted':
      return 'Test run cancelled before it finished.';
    case 'nothing-matched':
      return 'The test run finished, but its mode/filter matched no tests — nothing ran.';
    case 'not-installed':
      return "Unity's Test Framework is not installed in this project — install " +
        '`com.unity.test-framework` to run tests.';
    case 'editor-asleep':
      return "Test run accepted, but Unity's window is in the background so it has not started; " +
        'results appear in the Test panel when it ticks.';
    case 'bridge-lost':
      return 'Test run status unknown: the Unity bridge disconnected before it finished. ' +
        'It reconnects automatically after a reload — check the Test panel once it does.';
    case 'timeout':
    default:
      return "Test run status unknown: timed out waiting for Unity's result. " +
        'Check the Test panel — the run may still be in progress.';
  }
}
