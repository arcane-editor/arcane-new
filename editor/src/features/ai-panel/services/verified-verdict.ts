/**
 * The verdict shown on the VerifiedCard header.
 *
 * The card used to compute `allOk = compileMarker !== 'bad' && …`, and a skipped
 * check is `'skip'`, not `'bad'`. So a pass in which compile, analyzers AND GUID
 * integrity were ALL skipped — no Unity bridge, budget exhausted — rendered a
 * green shield reading "Verified". Nothing had been verified.
 *
 * That is the product's trust surface, so the distinction is explicit here and
 * unit-tested, rather than being an incidental property of a boolean in JSX.
 */

import type { ConsoleCheckResult, TestsCheckResult } from './console-check';

export type CheckMarker = 'ok' | 'bad' | 'skip';

export type VerifiedVerdict =
  /** At least one check ran and none failed. */
  | 'passed'
  /** At least one check failed. */
  | 'failed'
  /** Nothing actually ran — never show this as a pass. */
  | 'unverified';

export function verifiedVerdict(markers: CheckMarker[]): VerifiedVerdict {
  if (markers.some((m) => m === 'bad')) return 'failed';
  if (markers.every((m) => m === 'skip')) return 'unverified';
  return 'passed';
}

/** Header text for each verdict. */
export function verdictTitle(verdict: VerifiedVerdict): string {
  switch (verdict) {
    case 'passed':
      return 'Verified';
    case 'failed':
      return 'Verification failed';
    case 'unverified':
      return 'Not verified';
  }
}

// ---- Task 13: the console and tests rows ----

/**
 * The console row's marker.
 *
 * The subtle case is a turn that left errors behind with NO repair pass (the
 * user turned auto-repair off, or the bridge dropped): `remaining` is 0
 * because nothing was re-observed, but the errors are still there. Reporting
 * that as a pass is exactly the failure this card exists to prevent, so an
 * un-repaired own-project error is `bad` on its own.
 *
 * `notReobserved` alone is `ok`: the repair ran and nothing came back. The
 * card's own wording ("not seen again (needs Play Mode to confirm)") is what
 * keeps that from over-claiming.
 */
export function consoleMarker(result: ConsoleCheckResult): CheckMarker {
  if (result === 'skipped') return 'skip';
  if (result === 'clean') return 'ok';
  if ('unknown' in result) return 'skip';
  // A repair ran on real errors and the read that was supposed to judge it was
  // degraded. `skip` would let the shield go green over an unproven repair, so
  // this is the one "unknown" that counts against the card.
  if ('repairAttempted' in result) return 'bad';
  if (result.remaining > 0) return 'bad';
  const own = result.newErrors - result.external;
  if (!result.repaired && own > 0) return 'bad';
  return 'ok';
}

/** The tests row's marker. A failing test is a failing send, however many passed. */
export function testsMarker(tests: TestsCheckResult): CheckMarker {
  if (tests === 'skipped') return 'skip';
  // A run that never finished proved nothing either way, so it must not go
  // green — and it is not a failure the agent caused, so it must not go red.
  if ('unfinished' in tests) return 'skip';
  return tests.failed > 0 ? 'bad' : 'ok';
}
