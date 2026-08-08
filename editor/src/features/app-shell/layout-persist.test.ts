import { describe, expect, it } from 'bun:test';
import { createLayoutPersister } from './layout-persist';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('createLayoutPersister', () => {
  it('writes once for a burst of calls', async () => {
    const writes: number[] = [];
    const p = createLayoutPersister<number>((v) => { writes.push(v); }, 10);
    for (let i = 1; i <= 20; i++) p.persist(i);
    expect(writes).toEqual([]);
    await tick(30);
    expect(writes).toEqual([20]);
  });

  it('writes again after the window closes', async () => {
    const writes: number[] = [];
    const p = createLayoutPersister<number>((v) => { writes.push(v); }, 10);
    p.persist(1);
    await tick(30);
    p.persist(2);
    await tick(30);
    expect(writes).toEqual([1, 2]);
  });

  // A hard quit right after releasing a drag must not lose it. delayMs is
  // small and the post-flush wait goes well past it (3x margin, matching the
  // tests above) so a flush() that wrote the value out but left `pending`
  // set for the still-scheduled timer to find would produce a visible
  // second write within the wait — not just fail to null it fast enough.
  // (Nulling `pending` alone, even without also cancelling the timer, is
  // already enough to prevent that: the timer callback re-reads `pending`
  // and no-ops if it's null. What this test actually pins down is that
  // flush() drains `pending`, which is the half of "clear()" that a stale
  // timer can observe — clearTimeout's effect on the handle itself isn't
  // independently distinguishable from here.)
  it('flush writes the pending value immediately', async () => {
    const writes: number[] = [];
    const p = createLayoutPersister<number>((v) => { writes.push(v); }, 30);
    p.persist(7);
    p.flush();
    expect(writes).toEqual([7]);
    await tick(90);
    expect(writes).toEqual([7]); // the timer did not fire a second write
  });

  it('flush is a no-op when nothing is pending', () => {
    const writes: number[] = [];
    const p = createLayoutPersister<number>((v) => { writes.push(v); }, 10);
    p.flush();
    p.flush();
    expect(writes).toEqual([]);
  });

  it('cancel drops the pending write', async () => {
    const writes: number[] = [];
    const p = createLayoutPersister<number>((v) => { writes.push(v); }, 10);
    p.persist(1);
    p.cancel();
    await tick(30);
    expect(writes).toEqual([]);
  });
});
