import { describe, it, expect } from 'bun:test';
import { verifiedVerdict, verdictTitle, consoleMarker, testsMarker } from './verified-verdict';

describe('verifiedVerdict', () => {
  // The regression. A skipped check is not a passing one, and this card is the
  // "AI you can trust" surface — a green shield over three skipped checks is the
  // most expensive kind of wrong.
  it('is "unverified" when every check was skipped', () => {
    expect(verifiedVerdict(['skip', 'skip', 'skip'])).toBe('unverified');
  });

  it('is "passed" when at least one check actually ran and none failed', () => {
    expect(verifiedVerdict(['ok', 'skip', 'skip'])).toBe('passed');
  });

  it('is "failed" as soon as any check failed, however many were skipped', () => {
    expect(verifiedVerdict(['skip', 'bad', 'skip'])).toBe('failed');
    expect(verifiedVerdict(['ok', 'bad', 'ok'])).toBe('failed');
  });

  it('is "passed" when everything ran cleanly', () => {
    expect(verifiedVerdict(['ok', 'ok', 'ok'])).toBe('passed');
  });

  it('never labels an unverified pass as "Verified"', () => {
    expect(verdictTitle('unverified')).toBe('Not verified');
    expect(verdictTitle('passed')).toBe('Verified');
    expect(verdictTitle('failed')).toBe('Verification failed');
  });
});

describe('consoleMarker (Task 13)', () => {
  const result = (over: Partial<{
    newErrors: number;
    external: number;
    repaired: boolean;
    fixed: number;
    notReobserved: number;
    remaining: number;
  }> = {}) => ({
    newErrors: 1,
    external: 0,
    repaired: false,
    fixed: 0,
    notReobserved: 0,
    remaining: 0,
    items: [],
    ...over,
  });

  it('is "skip" when the check did not run, or ran and could not say', () => {
    expect(consoleMarker('skipped')).toBe('skip');
    expect(consoleMarker({ unknown: 'no-bridge' })).toBe('skip');
    expect(consoleMarker({ unknown: 'editor-asleep' })).toBe('skip');
    expect(consoleMarker({ unknown: 'old-package' })).toBe('skip');
  });

  it('is "ok" for a clean console', () => {
    expect(consoleMarker('clean')).toBe('ok');
  });

  it('is "bad" as soon as an error was observed again after the repair', () => {
    expect(consoleMarker(result({ repaired: true, remaining: 1 }))).toBe('bad');
  });

  // The regression this marker exists for: no repair pass means `remaining` is
  // 0 for the trivial reason that nothing was re-checked. A green tick beside
  // "console: 2 new errors" is the card lying.
  it('is "bad" for errors this project owns when NO repair pass ran', () => {
    expect(consoleMarker(result({ newErrors: 2, repaired: false }))).toBe('bad');
  });

  it('is "ok" when every un-repaired error came from a package or the engine', () => {
    expect(consoleMarker(result({ newErrors: 2, external: 2, repaired: false }))).toBe('ok');
  });

  it('is "ok" when the repair ran and nothing was seen again', () => {
    expect(consoleMarker(result({ newErrors: 2, repaired: true, notReobserved: 2 }))).toBe('ok');
  });
});

describe('testsMarker (Task 13)', () => {
  it('is "skip" when no run was recorded this send', () => {
    expect(testsMarker('skipped')).toBe('skip');
  });

  it('is "bad" for any failure, however many passed', () => {
    expect(
      testsMarker({ mode: 'EditMode', passed: 99, failed: 1, skipped: 0, failures: [] }),
    ).toBe('bad');
  });

  it('is "ok" for a fully passing run', () => {
    expect(
      testsMarker({ mode: 'EditMode', passed: 12, failed: 0, skipped: 2, failures: [] }),
    ).toBe('ok');
  });
});

describe('the verdict folds the new rows in', () => {
  it('a failed test alone fails the whole card', () => {
    expect(verifiedVerdict(['ok', 'ok', testsMarker({ mode: 'EditMode', passed: 1, failed: 1, skipped: 0, failures: [] })])).toBe('failed');
  });

  it('an unknown console row never rescues an otherwise-empty pass', () => {
    expect(verifiedVerdict(['skip', 'skip', consoleMarker({ unknown: 'no-bridge' })])).toBe('unverified');
  });
});
