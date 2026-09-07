import { describe, it, expect } from 'bun:test';
import { createSaveScheduler } from './save-scheduler';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('createSaveScheduler', () => {
  it('writes once for a burst of typing rather than once per keystroke', async () => {
    let saves = 0;
    const s = createSaveScheduler({ save: async () => void saves++, delayMs: 20 });

    for (let i = 0; i < 10; i++) {
      s.schedule();
      await tick(2);
    }
    expect(saves).toBe(0);
    await tick(40);
    expect(saves).toBe(1);
  });

  // Execute reads the file from DISK (`runPlanExecution` re-reads `planPath`),
  // and refuses to run at all while the tab is dirty — so anything that starts
  // a run has to be able to force the pending write out first.
  it('flush writes immediately and resolves only once the write is done', async () => {
    const order: string[] = [];
    const s = createSaveScheduler({
      save: async () => {
        order.push('save-start');
        await tick(10);
        order.push('save-end');
      },
      delayMs: 1000,
    });

    s.schedule();
    await s.flush();
    order.push('after-flush');
    expect(order).toEqual(['save-start', 'save-end', 'after-flush']);
  });

  it('flush with nothing pending is a no-op, not a spurious write', async () => {
    let saves = 0;
    const s = createSaveScheduler({ save: async () => void saves++, delayMs: 20 });
    await s.flush();
    expect(saves).toBe(0);
  });

  it('cancels the pending timer when flushed, so the write does not happen twice', async () => {
    let saves = 0;
    const s = createSaveScheduler({ save: async () => void saves++, delayMs: 20 });
    s.schedule();
    await s.flush();
    await tick(40);
    expect(saves).toBe(1);
  });

  it('schedules again after a flush', async () => {
    let saves = 0;
    const s = createSaveScheduler({ save: async () => void saves++, delayMs: 10 });
    s.schedule();
    await s.flush();
    s.schedule();
    await tick(30);
    expect(saves).toBe(2);
  });

  it('cancel drops a pending write without performing it', async () => {
    let saves = 0;
    const s = createSaveScheduler({ save: async () => void saves++, delayMs: 10 });
    s.schedule();
    s.cancel();
    await tick(30);
    expect(saves).toBe(0);
  });

  // A failed disk write must not wedge the scheduler — the next keystroke has
  // to be able to schedule another attempt.
  it('survives a save that rejects and keeps working', async () => {
    let calls = 0;
    const s = createSaveScheduler({
      save: async () => {
        calls++;
        if (calls === 1) throw new Error('disk full');
      },
      delayMs: 5,
    });

    s.schedule();
    await tick(20);
    expect(calls).toBe(1);

    s.schedule();
    await tick(20);
    expect(calls).toBe(2);
  });

  it('never overlaps two writes — a flush during an in-flight save waits for it', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const s = createSaveScheduler({
      save: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await tick(15);
        inFlight--;
      },
      delayMs: 5,
    });

    s.schedule();
    await tick(8); // the timer has fired; the save is running
    s.schedule();
    await s.flush();
    expect(maxInFlight).toBe(1);
  });
});
