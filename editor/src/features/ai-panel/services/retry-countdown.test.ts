import { describe, it, expect } from 'bun:test';
import { retryUnlocked, formatRetryCountdown } from './retry-countdown';

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
