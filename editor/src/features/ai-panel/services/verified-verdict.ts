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
