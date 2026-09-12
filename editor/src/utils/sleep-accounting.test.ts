import { describe, it, expect } from 'bun:test';
import { createSleepTracker, EDITOR_ASLEEP_GRACE_MS, type SleepTimers } from './sleep-accounting';

/** Manual timer fake: fire timers by advancing a virtual clock. */
class FakeTimers implements SleepTimers {
  private seq = 0;
  private clock = 0;
  timers = new Map<number, { at: number; fn: () => void }>();

  set(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.clock + ms, fn });
    return id;
  }

  clear(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  now(): number {
    return this.clock;
  }

  advance(ms: number): void {
    const target = this.clock + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.clock = due[1].at;
      this.timers.delete(due[0]);
      due[1].fn();
    }
    this.clock = target;
  }
}

describe('createSleepTracker', () => {
  it('fires onAsleep once the editor has been parked for the full grace window', () => {
    const timers = new FakeTimers();
    let fired = 0;
    const tracker = createSleepTracker({ timers, onAsleep: () => fired++ });

    tracker.update(false);
    timers.advance(EDITOR_ASLEEP_GRACE_MS - 1);
    expect(fired).toBe(0);
    timers.advance(1);
    expect(fired).toBe(1);
  });

  it('never fires while the editor stays awake', () => {
    const timers = new FakeTimers();
    let fired = 0;
    const tracker = createSleepTracker({ timers, onAsleep: () => fired++ });

    tracker.update(true);
    timers.advance(EDITOR_ASLEEP_GRACE_MS * 5);
    expect(fired).toBe(0);
  });

  it('cancels the countdown once the editor wakes back up', () => {
    const timers = new FakeTimers();
    let fired = 0;
    const tracker = createSleepTracker({ timers, onAsleep: () => fired++ });

    tracker.update(false);
    timers.advance(EDITOR_ASLEEP_GRACE_MS / 2);
    tracker.update(true);
    timers.advance(EDITOR_ASLEEP_GRACE_MS * 5);
    expect(fired).toBe(0);
  });

  it('accumulates sleep across wake flickers instead of restarting the countdown', () => {
    // A backgrounded editor ticking slowly sits right on the package's awake
    // threshold, so heartbeats alternate. Re-arming on every flicker meant the
    // countdown never completed — this is the whole reason the accounting is
    // cumulative, not consecutive.
    const timers = new FakeTimers();
    let fired = 0;
    const tracker = createSleepTracker({ timers, onAsleep: () => fired++ });

    // 2s heartbeats, half of them awake: ~16s of wall clock to bank 8s asleep.
    for (let i = 0; i < 10 && fired === 0; i++) {
      timers.advance(2000);
      tracker.update(i % 2 === 0);
    }
    expect(fired).toBe(1);
  });

  it('clear() cancels a pending countdown', () => {
    const timers = new FakeTimers();
    let fired = 0;
    const tracker = createSleepTracker({ timers, onAsleep: () => fired++ });

    tracker.update(false);
    tracker.clear();
    timers.advance(EDITOR_ASLEEP_GRACE_MS * 5);
    expect(fired).toBe(0);
  });

  it('honours a custom graceMs instead of the default', () => {
    const timers = new FakeTimers();
    let fired = 0;
    const tracker = createSleepTracker({ timers, graceMs: 3_000, onAsleep: () => fired++ });

    tracker.update(false);
    timers.advance(2_999);
    expect(fired).toBe(0);
    timers.advance(1);
    expect(fired).toBe(1);
  });

  it('does not re-arm a second timer while one is already counting down', () => {
    const timers = new FakeTimers();
    let fired = 0;
    const tracker = createSleepTracker({ timers, onAsleep: () => fired++ });

    tracker.update(false);
    tracker.update(false); // redundant asleep reading — must not reset the deadline
    timers.advance(EDITOR_ASLEEP_GRACE_MS);
    expect(fired).toBe(1);
  });
});
