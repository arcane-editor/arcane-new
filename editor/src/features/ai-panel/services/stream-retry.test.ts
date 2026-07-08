import { describe, it, expect, mock } from 'bun:test';
import {
  isTransient,
  computeBackoffMs,
  combineSignals,
  sleep,
  raceWithTimeout,
  TimeoutRaceError,
} from './stream-retry';

describe('isTransient', () => {
  it('classifies 429 (rate limit) as transient', () => {
    expect(isTransient(429)).toBe(true);
  });

  it('classifies 5xx server errors as transient', () => {
    expect(isTransient(500)).toBe(true);
    expect(isTransient(502)).toBe(true);
    expect(isTransient(503)).toBe(true);
    expect(isTransient(599)).toBe(true);
  });

  it('classifies 408 (request timeout) as transient', () => {
    // Documented decision: 408 signals the server gave up waiting on the
    // request pipeline rather than rejecting it outright — the same
    // "retry is safe" shape as 429/5xx, unlike a real 4xx client error.
    expect(isTransient(408)).toBe(true);
  });

  it('classifies 4xx client errors (other than 408/429) as non-transient', () => {
    expect(isTransient(400)).toBe(false);
    expect(isTransient(401)).toBe(false);
    expect(isTransient(403)).toBe(false);
    expect(isTransient(404)).toBe(false);
  });

  it('classifies 2xx/3xx as non-transient', () => {
    expect(isTransient(200)).toBe(false);
    expect(isTransient(304)).toBe(false);
  });
});

describe('computeBackoffMs', () => {
  it('computes linear backoff: baseDelayMs * attempt', () => {
    expect(computeBackoffMs(1, 5_000)).toBe(5_000);
    expect(computeBackoffMs(2, 5_000)).toBe(10_000);
    expect(computeBackoffMs(1, 20_000)).toBe(20_000);
    expect(computeBackoffMs(2, 20_000)).toBe(40_000);
  });
});

describe('combineSignals', () => {
  it('returns a non-aborted signal when given no signals', () => {
    const combined = combineSignals([undefined, undefined]);
    expect(combined.aborted).toBe(false);
  });

  it('filters out undefined entries and returns the single defined signal aborted state', () => {
    const controller = new AbortController();
    const combined = combineSignals([undefined, controller.signal]);
    expect(combined.aborted).toBe(false);
    controller.abort();
    expect(combined.aborted).toBe(true);
  });

  it('aborts when either input signal aborts (caller signal wins)', () => {
    const caller = new AbortController();
    const timeout = new AbortController();
    const combined = combineSignals([caller.signal, timeout.signal]);
    caller.abort();
    expect(combined.aborted).toBe(true);
  });

  it('aborts when the other input signal aborts (timeout wins)', () => {
    const caller = new AbortController();
    const timeout = new AbortController();
    const combined = combineSignals([caller.signal, timeout.signal]);
    timeout.abort();
    expect(combined.aborted).toBe(true);
  });
});

describe('sleep', () => {
  it('resolves after roughly the requested delay', async () => {
    const start = Date.now();
    await sleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  it('rejects immediately with an AbortError if the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(1_000, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects with an AbortError mid-sleep when the signal aborts before the delay elapses', async () => {
    const controller = new AbortController();
    const start = Date.now();
    setTimeout(() => controller.abort(), 10);
    await expect(sleep(1_000, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    // Must reject promptly (well before the full 1000ms delay), proving the
    // caller's abort signal is respected during a backoff wait rather than
    // silently waiting out the full sleep.
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('does not reject once the signal aborts after the sleep already resolved', async () => {
    const controller = new AbortController();
    await sleep(5, controller.signal);
    controller.abort();
    // No unhandled rejection / throw — the sleep already settled cleanly.
    expect(controller.signal.aborted).toBe(true);
  });
});

describe('raceWithTimeout', () => {
  it('resolves with the inner promise value when it settles before the timeout', async () => {
    const result = await raceWithTimeout(Promise.resolve('ok'), 1_000, 'timed out');
    expect(result).toBe('ok');
  });

  it('propagates the inner promise rejection when it rejects before the timeout', async () => {
    await expect(
      raceWithTimeout(Promise.reject(new Error('boom')), 1_000, 'timed out'),
    ).rejects.toThrow('boom');
  });

  it('rejects with a TimeoutRaceError and invokes onTimeout when the inner promise never settles in time', async () => {
    const onTimeout = mock(() => {});
    const neverSettles = new Promise<string>(() => {});
    await expect(raceWithTimeout(neverSettles, 20, 'stalled')).rejects.toThrow(TimeoutRaceError);
    expect(onTimeout).toHaveBeenCalledTimes(0); // not passed in this call
    const onTimeout2 = mock(() => {});
    await expect(raceWithTimeout(new Promise(() => {}), 20, 'stalled', onTimeout2)).rejects.toMatchObject({
      name: 'TimeoutRaceError',
      message: 'stalled',
    });
    expect(onTimeout2).toHaveBeenCalledTimes(1);
  });
});
