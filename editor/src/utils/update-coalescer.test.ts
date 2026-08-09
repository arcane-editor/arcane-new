import { describe, it, expect, mock } from 'bun:test';
import { createUpdateCoalescer } from './update-coalescer';

/**
 * Deterministic fake scheduler/clock so the coalescer's trailing-edge timing
 * can be tested without real setTimeout waits. `advance(ms)` moves the fake
 * clock forward and fires any timer whose deadline has been reached, in the
 * order they were scheduled (there's only ever one pending timer per
 * coalescer instance in practice, but this supports more for safety).
 */
function makeFakeScheduler() {
  let currentTime = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; cb: () => void }>();

  return {
    now: () => currentTime,
    schedule: (cb: () => void, delayMs: number) => {
      const id = nextId++;
      timers.set(id, { at: currentTime + delayMs, cb });
      return id;
    },
    cancel: (handle: unknown) => {
      timers.delete(handle as number);
    },
    advance(ms: number) {
      currentTime += ms;
      // Snapshot before firing — a fired callback may schedule a new timer
      // (it won't in this coalescer, but don't rely on that here).
      for (const [id, timer] of [...timers.entries()]) {
        if (timer.at <= currentTime) {
          timers.delete(id);
          timer.cb();
        }
      }
    },
    pendingCount: () => timers.size,
  };
}

describe('createUpdateCoalescer', () => {
  it('applies the first push immediately (no flush pending, no prior apply)', () => {
    const scheduler = makeFakeScheduler();
    const apply = mock((_item: string) => {});
    const coalescer = createUpdateCoalescer<string>({
      windowMs: 40,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      now: scheduler.now,
      apply,
    });

    coalescer.push('a');

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith('a');
    expect(scheduler.pendingCount()).toBe(0);
  });

  it('coalesces a burst of pushes within the window into a single trailing flush with the LATEST item', () => {
    const scheduler = makeFakeScheduler();
    const applied: string[] = [];
    const apply = mock((item: string) => applied.push(item));
    const coalescer = createUpdateCoalescer<string>({
      windowMs: 40,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      now: scheduler.now,
      apply,
    });

    coalescer.push('a'); // immediate (first push)
    expect(applied).toEqual(['a']);

    // Burst within the window — none of these should apply synchronously.
    scheduler.advance(5);
    coalescer.push('b');
    scheduler.advance(5);
    coalescer.push('c');
    scheduler.advance(5);
    coalescer.push('d');

    expect(applied).toEqual(['a']); // still just the immediate one
    expect(scheduler.pendingCount()).toBe(1); // exactly one trailing flush scheduled

    // Advance past the trailing window — the single scheduled flush fires
    // with the LATEST pushed item, not 'b' or 'c'.
    scheduler.advance(100);

    expect(applied).toEqual(['a', 'd']);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('applies immediately again once the window has elapsed since the last apply', () => {
    const scheduler = makeFakeScheduler();
    const applied: string[] = [];
    const apply = mock((item: string) => applied.push(item));
    const coalescer = createUpdateCoalescer<string>({
      windowMs: 40,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      now: scheduler.now,
      apply,
    });

    coalescer.push('a');
    scheduler.advance(41); // > windowMs since last apply, no flush pending
    coalescer.push('b');

    expect(applied).toEqual(['a', 'b']);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it('cancel() suppresses a pending trailing flush', () => {
    const scheduler = makeFakeScheduler();
    const apply = mock((_item: string) => {});
    const coalescer = createUpdateCoalescer<string>({
      windowMs: 40,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      now: scheduler.now,
      apply,
    });

    coalescer.push('a'); // immediate
    coalescer.push('b'); // stashed, trailing flush scheduled
    expect(scheduler.pendingCount()).toBe(1);

    coalescer.cancel();
    expect(scheduler.pendingCount()).toBe(0);

    scheduler.advance(1000);
    expect(apply).toHaveBeenCalledTimes(1); // only the immediate 'a' — 'b' never applied
  });

  it('a push after cancel() starts fresh (immediate if the window has elapsed)', () => {
    const scheduler = makeFakeScheduler();
    const applied: string[] = [];
    const apply = mock((item: string) => applied.push(item));
    const coalescer = createUpdateCoalescer<string>({
      windowMs: 40,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      now: scheduler.now,
      apply,
    });

    coalescer.push('a');
    coalescer.push('b'); // stashed
    coalescer.cancel();

    scheduler.advance(100);
    coalescer.push('c');

    expect(applied).toEqual(['a', 'c']);
  });

  it('guards against a late flush becoming a no-op via the injected apply callback (simulates the store re-check)', () => {
    const scheduler = makeFakeScheduler();
    // Simulates `stores/ai.ts`'s guard: the apply callback re-checks live
    // state (e.g. `get().streamingMessageId`) and no-ops if it's gone —
    // exercised here as a flag flipped between push and flush.
    let guardOpen = true;
    const applied: string[] = [];
    const apply = mock((item: string) => {
      if (!guardOpen) return; // late flush after end/truncate/abort — no-op
      applied.push(item);
    });
    const coalescer = createUpdateCoalescer<string>({
      windowMs: 40,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      now: scheduler.now,
      apply,
    });

    coalescer.push('a'); // immediate, guard open
    coalescer.push('b'); // stashed, trailing flush scheduled

    guardOpen = false; // e.g. message_end/agent_end fired before the trailing flush
    scheduler.advance(100);

    expect(apply).toHaveBeenCalledTimes(2); // flush still invoked...
    expect(applied).toEqual(['a']); // ...but the second call was a guarded no-op
  });

  it('uses real timers/clock by default when no scheduler is injected', async () => {
    const applied: number[] = [];
    const coalescer = createUpdateCoalescer<number>({
      windowMs: 20,
      apply: (item) => applied.push(item),
    });

    coalescer.push(1);
    expect(applied).toEqual([1]);
    coalescer.push(2);
    coalescer.push(3);
    expect(applied).toEqual([1]);

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(applied).toEqual([1, 3]);
  });
});
