import { describe, it, expect } from 'bun:test';
import { singleFlightWithRerun } from '../utils/single-flight';

/** Advance microtasks until `predicate` is true (or give up after `maxTicks`). */
async function flushUntil(predicate: () => boolean, maxTicks = 20) {
  for (let i = 0; i < maxTicks && !predicate(); i++) {
    await Promise.resolve();
  }
}

describe('singleFlightWithRerun', () => {
  it('coalesces a call that arrives mid-flight: fn is called twice total (one rerun), and the second caller shares the first caller\'s promise', async () => {
    let callCount = 0;
    const gates: Array<() => void> = [];
    const fn = () =>
      new Promise<void>((resolve) => {
        callCount++;
        gates.push(resolve);
      });

    const wrapped = singleFlightWithRerun(fn);

    const first = wrapped();
    expect(callCount).toBe(1);

    // Arrives while the first call is still in flight.
    const second = wrapped();
    expect(second).toBe(first); // same promise, not a new concurrent run
    expect(callCount).toBe(1); // no second invocation started yet

    // Resolve the first underlying call -> the trailing rerun fires.
    gates[0]();
    await flushUntil(() => callCount === 2);
    expect(callCount).toBe(2); // exactly one rerun, not more

    // Neither caller has resolved yet — the rerun (triggered by `second`)
    // must complete before `refreshStatus` is considered "done".
    let firstSettled = false;
    first.then(() => { firstSettled = true; });
    await flushUntil(() => false, 2); // let any spurious resolution show up
    expect(firstSettled).toBe(false);

    gates[1]();
    await first;
    await second;
    expect(firstSettled).toBe(true);
  });

  it('starts a fresh run for a call that arrives after the previous run (and its rerun) fully settled', async () => {
    let callCount = 0;
    const gates: Array<() => void> = [];
    const fn = () =>
      new Promise<void>((resolve) => {
        callCount++;
        gates.push(resolve);
      });
    const wrapped = singleFlightWithRerun(fn);

    const first = wrapped();
    gates[0]();
    await first;
    expect(callCount).toBe(1);

    const second = wrapped();
    expect(second).not.toBe(first);
    expect(callCount).toBe(2);
    gates[1]();
    await second;
  });

  it('propagates a rejection to the awaiter and clears in-flight state so a later call starts fresh', async () => {
    let callCount = 0;
    const fn = () => {
      callCount++;
      return Promise.reject(new Error('boom'));
    };
    const wrapped = singleFlightWithRerun(fn);

    await expect(wrapped()).rejects.toThrow('boom');
    expect(callCount).toBe(1);

    // A later call is a fresh invocation, not a reuse of the rejected run.
    await expect(wrapped()).rejects.toThrow('boom');
    expect(callCount).toBe(2);
  });
});
