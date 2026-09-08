// The gate that keeps a mid-solution-load `textDocument/diagnostic` answer
// (a CS0518 "Predefined type 'System.Void' is not defined" cascade over the
// whole file) from ever reaching Monaco. Pure module state — no monaco, no
// Tauri — so it is unit-testable end to end.

import { describe, it, expect, afterEach } from 'bun:test';
import {
  isCsharpProjectLoaded,
  markCsharpProjectLoaded,
  markCsharpProjectLoading,
  resetCsharpProjectLoaded,
  onCsharpProjectLoaded,
  whenCsharpProjectLoaded,
  CSHARP_READINESS_FAILSAFE_MS,
} from './project-readiness';

// Module state is global; open the gate after each test so a pending failsafe
// timer from `resetCsharpProjectLoaded` can't leak into the next one.
afterEach(() => {
  markCsharpProjectLoaded();
});

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the gate', () => {
  it('starts closed for a freshly started server', () => {
    resetCsharpProjectLoaded();
    expect(isCsharpProjectLoaded()).toBe(false);
  });

  it('opens on the load-finished marker', () => {
    resetCsharpProjectLoaded();
    markCsharpProjectLoaded();
    expect(isCsharpProjectLoaded()).toBe(true);
  });

  it('closes again on restart — a rebuilt project graph is not yet loaded', () => {
    markCsharpProjectLoaded();
    resetCsharpProjectLoaded();
    expect(isCsharpProjectLoaded()).toBe(false);
  });
});

describe('listeners', () => {
  it('fire when the gate opens', () => {
    resetCsharpProjectLoaded();
    let fired = 0;
    const unsub = onCsharpProjectLoaded(() => fired++);

    expect(fired).toBe(0);
    markCsharpProjectLoaded();
    expect(fired).toBe(1);

    unsub();
  });

  it('fire again after a restart, so the re-pull repeats per server lifetime', () => {
    resetCsharpProjectLoaded();
    let fired = 0;
    const unsub = onCsharpProjectLoaded(() => fired++);

    markCsharpProjectLoaded();
    resetCsharpProjectLoaded();
    markCsharpProjectLoaded();
    expect(fired).toBe(2);

    unsub();
  });

  it('fire only once per open — csharp-ls logs a marker per project', () => {
    resetCsharpProjectLoaded();
    let fired = 0;
    const unsub = onCsharpProjectLoaded(() => fired++);

    markCsharpProjectLoaded();
    markCsharpProjectLoaded();
    markCsharpProjectLoaded();
    expect(fired).toBe(1);

    unsub();
  });

  it('stop firing once unsubscribed', () => {
    resetCsharpProjectLoaded();
    let fired = 0;
    const unsub = onCsharpProjectLoaded(() => fired++);
    unsub();

    markCsharpProjectLoaded();
    expect(fired).toBe(0);
  });

  it('a throwing listener does not stop the others', () => {
    resetCsharpProjectLoaded();
    let reached = false;
    const unsubA = onCsharpProjectLoaded(() => {
      throw new Error('boom');
    });
    const unsubB = onCsharpProjectLoaded(() => {
      reached = true;
    });

    expect(() => markCsharpProjectLoaded()).not.toThrow();
    expect(reached).toBe(true);

    unsubA();
    unsubB();
  });
});

describe('whenCsharpProjectLoaded', () => {
  it('resolves immediately when the gate is already open', async () => {
    markCsharpProjectLoaded();
    await whenCsharpProjectLoaded(); // would hang the test if it did not resolve
    expect(isCsharpProjectLoaded()).toBe(true);
  });

  it('resolves when the gate opens later', async () => {
    resetCsharpProjectLoaded();
    let resolved = false;
    const waiting = whenCsharpProjectLoaded().then(() => {
      resolved = true;
    });

    await tick(0);
    expect(resolved).toBe(false);

    markCsharpProjectLoaded();
    await waiting;
    expect(resolved).toBe(true);
  });

  it('unsubscribes itself, so a later restart cycle does not re-resolve a dead promise', async () => {
    resetCsharpProjectLoaded();
    await Promise.all([whenCsharpProjectLoaded(), Promise.resolve().then(markCsharpProjectLoaded)]);

    // No listeners should remain — a subsequent cycle is observable only by a
    // fresh subscriber. Nothing to assert directly on the Set, so assert the
    // behaviour: reset/mark must not throw on a stale resolved waiter.
    resetCsharpProjectLoaded();
    expect(() => markCsharpProjectLoaded()).not.toThrow();
  });
});

describe('the failsafe', () => {
  // A gate that can wedge shut would replace wrong diagnostics with no
  // diagnostics — silent failure, strictly worse. It must always open.
  it('opens the gate when no load-finished marker ever arrives', async () => {
    resetCsharpProjectLoaded(20);
    expect(isCsharpProjectLoaded()).toBe(false);

    await tick(50);
    expect(isCsharpProjectLoaded()).toBe(true);
  });

  it('notifies listeners when it fires, so the re-pull still happens', async () => {
    resetCsharpProjectLoaded(20);
    let fired = 0;
    const unsub = onCsharpProjectLoaded(() => fired++);

    await tick(50);
    expect(fired).toBe(1);

    unsub();
  });

  it('is cancelled by a real marker, so the gate opens exactly once', async () => {
    resetCsharpProjectLoaded(20);
    let fired = 0;
    const unsub = onCsharpProjectLoaded(() => fired++);

    markCsharpProjectLoaded();
    expect(fired).toBe(1);

    await tick(50);
    expect(fired).toBe(1); // the timer must not fire a second open

    unsub();
  });

  it('is re-armed by a restart rather than left on the previous cycle', async () => {
    resetCsharpProjectLoaded(20);
    markCsharpProjectLoaded();

    resetCsharpProjectLoaded(20);
    expect(isCsharpProjectLoaded()).toBe(false);
    await tick(50);
    expect(isCsharpProjectLoaded()).toBe(true);
  });

  it('defaults to a window far longer than a real solution load', () => {
    expect(CSHARP_READINESS_FAILSAFE_MS).toBeGreaterThanOrEqual(10_000);
  });
});

/**
 * On-demand solution loading (csharp-ls 0.23+).
 *
 * Nothing loads at `initialize`; the load begins with the first `didOpen`. So
 * readiness stopped being a one-time startup event the moment the server was
 * upgraded — it can go back to false minutes into a session. Without the
 * re-close below, a project whose first C# file is opened after the failsafe
 * has already fired gets its diagnostics answered out of an empty workspace: a
 * CS0518 cascade over every line, whose resultId is then cached and repeated
 * as `unchanged` until the app restarts.
 */
describe('a load that starts after the gate has opened', () => {
  it('closes the gate again', () => {
    resetCsharpProjectLoaded(10_000);
    markCsharpProjectLoaded();
    expect(isCsharpProjectLoaded()).toBe(true);

    markCsharpProjectLoading(10_000);
    expect(isCsharpProjectLoaded()).toBe(false);
  });

  it('re-opens the gate and notifies again when that load finishes', () => {
    resetCsharpProjectLoaded(10_000);
    let opens = 0;
    const unsub = onCsharpProjectLoaded(() => opens++);

    markCsharpProjectLoaded();
    expect(opens).toBe(1);

    markCsharpProjectLoading(10_000);
    markCsharpProjectLoaded();
    // The re-pull after the second load is the whole point: open C# models are
    // showing results computed against the previous, emptier graph.
    expect(opens).toBe(2);

    unsub();
  });

  it('is a no-op while a load is already in flight', () => {
    // csharp-ls logs one marker per project; the first close is enough.
    resetCsharpProjectLoaded(10_000);
    markCsharpProjectLoaded();
    markCsharpProjectLoading(10_000);
    markCsharpProjectLoading(10_000);
    markCsharpProjectLoaded();
    expect(isCsharpProjectLoaded()).toBe(true);
  });

  it('arms a failsafe, so a load that never reports finishing still opens', async () => {
    resetCsharpProjectLoaded(10_000);
    markCsharpProjectLoaded();
    markCsharpProjectLoading(20);
    expect(isCsharpProjectLoaded()).toBe(false);

    await tick(50);
    // A gate that can wedge shut trades wrong diagnostics for none at all,
    // which is worse: it fails silently.
    expect(isCsharpProjectLoaded()).toBe(true);
  });
});
