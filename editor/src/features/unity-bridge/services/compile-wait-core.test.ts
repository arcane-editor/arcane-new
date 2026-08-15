import { describe, it, expect } from 'bun:test';
import {
  waitForCompileReport,
  NO_COMPILE_QUIET_MS,
  PROBE_MS,
  OVERALL_TIMEOUT_MS,
  type CompileWaitIo,
  type UnitySnap,
  type CompileWaitTimers,
} from './compile-wait-core';
import type { CompilationPayload } from '../../../types/unity';

/** Manual timer fake: fire timers by advancing a virtual clock. */
class FakeTimers implements CompileWaitTimers {
  private seq = 0;
  private now = 0;
  timers = new Map<number, { at: number; fn: () => void }>();

  set(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  }

  clear(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Advance the clock, firing due timers in time order. */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.now = due[1].at;
      this.timers.delete(due[0]);
      due[1].fn();
      // Let promise continuations run between timer firings.
      await Promise.resolve();
    }
    this.now = target;
    await Promise.resolve();
  }
}

interface Harness {
  io: CompileWaitIo;
  timers: FakeTimers;
  /** Mutate the snapshot and notify subscribers. */
  update(patch: Partial<UnitySnap>): Promise<void>;
  /** Resolve/reject the pending refreshAssets call. */
  resolveRefresh(): Promise<void>;
  rejectRefresh(): Promise<void>;
  refreshCalls(): number;
}

function report(): CompilationPayload {
  return { started: false, success: true, errors: 0, warnings: 0, messages: [] };
}

function makeHarness(initial?: Partial<UnitySnap>): Harness {
  let snap: UnitySnap = {
    connected: true,
    bridgeState: 'connected',
    isCompiling: false,
    lastCompilation: null,
    ...initial,
  };
  const subs = new Set<(s: UnitySnap, p: UnitySnap) => void>();
  const pending: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  let calls = 0;
  const timers = new FakeTimers();

  return {
    timers,
    io: {
      getSnap: () => snap,
      subscribe: (cb) => {
        subs.add(cb);
        return () => subs.delete(cb);
      },
      refreshAssets: () => {
        calls++;
        return new Promise<void>((resolve, reject) => {
          pending.push({ resolve, reject });
        });
      },
    },
    update: async (patch) => {
      const prev = snap;
      snap = { ...snap, ...patch };
      for (const cb of subs) cb(snap, prev);
      await Promise.resolve();
    },
    resolveRefresh: async () => {
      pending.shift()?.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    rejectRefresh: async () => {
      pending.shift()?.reject(new Error('RPC timeout'));
      await Promise.resolve();
      await Promise.resolve();
    },
    refreshCalls: () => calls,
  };
}

describe('waitForCompileReport', () => {
  it('resolves with the report when a fresh lastCompilation lands', async () => {
    const h = makeHarness();
    const p = waitForCompileReport(h.io, { timers: h.timers });
    await h.resolveRefresh();
    const r = report();
    await h.update({ isCompiling: true });
    await h.update({ isCompiling: false, lastCompilation: r });
    expect(await p).toEqual({ status: 'report', report: r });
  });

  it('still resolves with the report when refreshAssets REJECTS first (reload flap)', async () => {
    const h = makeHarness();
    const p = waitForCompileReport(h.io, { timers: h.timers });
    await h.rejectRefresh();
    const r = report();
    await h.update({ lastCompilation: r });
    expect(await p).toEqual({ status: 'report', report: r });
  });

  it('retries refreshAssets once when rejected while still connected with no activity', async () => {
    const h = makeHarness();
    const p = waitForCompileReport(h.io, { timers: h.timers });
    await h.rejectRefresh();
    await h.timers.advance(PROBE_MS);
    expect(h.refreshCalls()).toBe(2);
    await h.resolveRefresh();
    const r = report();
    await h.update({ lastCompilation: r });
    expect(await p).toEqual({ status: 'report', report: r });
  });

  it('resolves bridge-lost when rejected, disconnected, and no activity for the probe window', async () => {
    const h = makeHarness();
    const p = waitForCompileReport(h.io, { timers: h.timers });
    await h.rejectRefresh();
    await h.update({ connected: false, bridgeState: 'disconnected' });
    await h.timers.advance(PROBE_MS);
    expect(await p).toEqual({ status: 'unknown', reason: 'bridge-lost' });
  });

  it('resolves no-compile when refresh succeeds but nothing compiles in the quiet window', async () => {
    const h = makeHarness();
    const p = waitForCompileReport(h.io, { timers: h.timers });
    await h.resolveRefresh();
    await h.timers.advance(NO_COMPILE_QUIET_MS);
    expect(await p).toEqual({ status: 'no-compile' });
  });

  it('does NOT resolve no-compile once compile activity was seen; times out honestly instead', async () => {
    const h = makeHarness();
    const p = waitForCompileReport(h.io, { timers: h.timers });
    await h.resolveRefresh();
    await h.update({ isCompiling: true });
    await h.timers.advance(NO_COMPILE_QUIET_MS);
    // still pending — advance to the overall cap
    await h.timers.advance(OVERALL_TIMEOUT_MS);
    expect(await p).toEqual({ status: 'unknown', reason: 'timeout' });
  });

  it('treats bridgeState reloading as activity (no bridge-lost during a domain reload)', async () => {
    const h = makeHarness();
    const p = waitForCompileReport(h.io, { timers: h.timers });
    await h.rejectRefresh();
    await h.update({ bridgeState: 'reloading' });
    await h.update({ connected: false, bridgeState: 'disconnected' });
    await h.timers.advance(PROBE_MS);
    // reload counted as activity → no bridge-lost; report arrives after reconnect
    const r = report();
    await h.update({ connected: true, bridgeState: 'connected', lastCompilation: r });
    expect(await p).toEqual({ status: 'report', report: r });
  });

  it('resolves aborted on signal abort and stops listening', async () => {
    const h = makeHarness();
    const ctrl = new AbortController();
    const p = waitForCompileReport(h.io, { timers: h.timers, signal: ctrl.signal });
    await h.resolveRefresh();
    ctrl.abort();
    expect(await p).toEqual({ status: 'unknown', reason: 'aborted' });
    // A report arriving after abort must not throw or change the settled result.
    await h.update({ lastCompilation: report() });
  });

  it('resolves aborted immediately when the signal is already aborted', async () => {
    const h = makeHarness();
    const ctrl = new AbortController();
    ctrl.abort();
    const p = waitForCompileReport(h.io, { timers: h.timers, signal: ctrl.signal });
    expect(await p).toEqual({ status: 'unknown', reason: 'aborted' });
    expect(h.refreshCalls()).toBe(0);
  });

  it('ignores a stale pre-existing lastCompilation object (identity-fresh only)', async () => {
    const stale = report();
    const h = makeHarness({ lastCompilation: stale });
    const p = waitForCompileReport(h.io, { timers: h.timers });
    await h.resolveRefresh();
    // Same identity re-set: not fresh.
    await h.update({ isCompiling: true });
    const fresh = report();
    await h.update({ isCompiling: false, lastCompilation: fresh });
    const out = await p;
    expect(out.status).toBe('report');
    if (out.status === 'report') expect(out.report).toBe(fresh);
  });
});
