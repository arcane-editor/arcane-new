import { describe, it, expect } from 'bun:test';
import { verifiedVerdict, verdictTitle } from './verified-verdict';

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
