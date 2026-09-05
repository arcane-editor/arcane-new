import { describe, it, expect } from 'bun:test';
import { retryUnlocked, formatRetryCountdown, resolveErrorDetail } from './retry-countdown';

describe('retryUnlocked', () => {
  it('is true when retryAt is undefined', () => {
    expect(retryUnlocked(undefined, Date.now())).toBe(true);
  });

  it('is false while now is before retryAt', () => {
    expect(retryUnlocked(1_000, 500)).toBe(false);
  });

  it('is true exactly at retryAt (now >= retryAt)', () => {
    expect(retryUnlocked(1_000, 1_000)).toBe(true);
  });

  it('is true once now has passed retryAt', () => {
    expect(retryUnlocked(1_000, 1_001)).toBe(true);
  });
});

describe('formatRetryCountdown', () => {
  it('formats minutes:seconds under an hour', () => {
    const now = 0;
    const retryAt = (46 * 60 + 12) * 1000;
    expect(formatRetryCountdown(retryAt, now)).toBe('46:12');
  });

  it('zero-pads single-digit seconds', () => {
    const now = 0;
    const retryAt = 9 * 1000;
    expect(formatRetryCountdown(retryAt, now)).toBe('0:09');
  });

  it('does not zero-pad single-digit minutes', () => {
    const now = 0;
    const retryAt = (1 * 60 + 5) * 1000;
    expect(formatRetryCountdown(retryAt, now)).toBe('1:05');
  });

  it('formats hours:minutes:seconds past an hour, zero-padding minutes and seconds', () => {
    const now = 0;
    const retryAt = (1 * 3600 + 2 * 60 + 5) * 1000;
    expect(formatRetryCountdown(retryAt, now)).toBe('1:02:05');
  });

  it('never goes negative once now has passed retryAt', () => {
    expect(formatRetryCountdown(1_000, 5_000)).toBe('0:00');
  });

  it('is exactly 0:00 at the retryAt boundary', () => {
    expect(formatRetryCountdown(1_000, 1_000)).toBe('0:00');
  });

  it('rounds up sub-second remainders rather than showing 0:00 while still locked', () => {
    // 500ms left — still locked, must not display as 0:00.
    expect(formatRetryCountdown(1_500, 1_000)).toBe('0:01');
  });

  it('rolls over minutes at the 60s boundary', () => {
    const now = 0;
    const retryAt = 60 * 1000;
    expect(formatRetryCountdown(retryAt, now)).toBe('1:00');
  });

  it('rolls over hours at the 3600s boundary', () => {
    const now = 0;
    const retryAt = 3600 * 1000;
    expect(formatRetryCountdown(retryAt, now)).toBe('1:00:00');
  });

  it('handles a multi-hour countdown', () => {
    const now = 0;
    const retryAt = (2 * 3600 + 5 * 60 + 9) * 1000;
    expect(formatRetryCountdown(retryAt, now)).toBe('2:05:09');
  });
});

// M8. `ErrorBlock` filled the `{countdown}` placeholder unconditionally, so the
// instant a lockout elapsed the card read "Retry unlocks in 0:00." — and a
// restored session whose `retryAt` was already in the past said it immediately.
describe('resolveErrorDetail', () => {
  const HOURLY_CAP = "You have used this hour's AI spend allowance. Retry unlocks in {countdown}.";
  const RATE_LIMIT = 'The model provider is busy. Retry unlocks in {countdown}.';

  it('fills the countdown while the lockout is still running', () => {
    expect(resolveErrorDetail(HOURLY_CAP, 1_000_000 + 90_000, 1_000_000)).toBe(
      "You have used this hour's AI spend allowance. Retry unlocks in 1:30.",
    );
  });

  it('drops the countdown sentence once the lockout has elapsed', () => {
    expect(resolveErrorDetail(HOURLY_CAP, 1_000_000, 1_000_000)).toBe(
      "You have used this hour's AI spend allowance.",
    );
    expect(resolveErrorDetail(RATE_LIMIT, 999_000, 1_000_000)).toBe('The model provider is busy.');
  });

  it('never renders "0:00"', () => {
    expect(resolveErrorDetail(HOURLY_CAP, 1_000_000, 5_000_000)).not.toContain('0:00');
    expect(resolveErrorDetail(HOURLY_CAP, 1_000_000, 5_000_000)).not.toContain('{countdown}');
  });

  it('leaves a detail with no lockout exactly as written', () => {
    const plain = 'This is usually temporary — try again in a moment.';
    expect(resolveErrorDetail(plain, undefined, 1_000_000)).toBe(plain);
    expect(resolveErrorDetail(undefined, 1_000_000, 1_000_000)).toBeUndefined();
  });

  it('keeps a non-countdown detail intact even once unlocked', () => {
    const plain = 'Too many requests — wait a moment and try again.';
    expect(resolveErrorDetail(plain, 1_000, 5_000)).toBe(plain);
  });

  it('renders no detail at all when the countdown sentence was the whole thing', () => {
    expect(resolveErrorDetail('Retry unlocks in {countdown}.', 1_000, 5_000)).toBeUndefined();
  });
});
