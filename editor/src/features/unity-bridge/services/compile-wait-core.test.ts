import { describe, it, expect } from 'bun:test';
import {
  waitForCompileReport,
  NO_COMPILE_QUIET_MS,
  PROBE_MS,
  OVERALL_TIMEOUT_MS,
  EDITOR_ASLEEP_GRACE_MS,
  type CompileWaitIo,
  type UnitySnap,
  type CompileWaitTimers,
  type CompileWaitOutcome,
} from './compile-wait-core';
import type { CompilationPayload } from '../../../types/unity';

/** Manual timer fake: fire timers by advancing a virtual clock. */
class FakeTimers implements CompileWaitTimers {
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

  /** The virtual clock the sleep accounting reads. */
  now(): number {
    return this.clock;
  }

  /** Advance the clock, firing due timers in time order. */
  async advance(ms: number): Promise<void> {
    const target = this.clock + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.clock = due[1].at;
      this.timers.delete(due[0]);
      due[1].fn();
      // Let promise continuations run between timer firings.
      await Promise.resolve();
    }
    this.clock = target;
    await Promise.resolve();
  }
}

interface Harness {
  io: CompileWaitIo;
  timers: FakeTimers;
  /** Mutate the snapshot and notify subscribers. */
  update(patch: Partial<UnitySnap>): Promise<void>;
  /** Resolve the pending requestCompile with the modern queued ack. */
  ackQueued(): Promise<void>;
  /** Resolve it the way a pre-queue package did: after the import really ran. */
  ackLegacy(): Promise<void>;
  rejectCompile(): Promise<void>;
  /** Unity reporting that the queued import actually executed. */
  /** Unity reporting a completed import; `compiling` = a build already in flight. */
  refreshRan(compiling?: boolean): Promise<void>;
  compileCalls(): number;
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
    editorAwake: true,
    refreshCompletedAt: 0,
    refreshCompiling: false,
    editorCanWake: true,
    ...initial,
  };
  const subs = new Set<(s: UnitySnap, p: UnitySnap) => void>();
  const pending: Array<{
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
  }> = [];
  let calls = 0;
  let ran = 0;
  const timers = new FakeTimers();

  const update = async (patch: Partial<UnitySnap>) => {
    const prev = snap;
    snap = { ...snap, ...patch };
    for (const cb of subs) cb(snap, prev);
    await Promise.resolve();
  };

  const settle = async (v: unknown, fail?: boolean) => {
    const p = pending.shift();
    if (fail) p?.reject(new Error('RPC timeout'));
    else p?.resolve(v);
    await Promise.resolve();
    await Promise.resolve();
  };

  return {
    timers,
    io: {
      getSnap: () => snap,
      subscribe: (cb) => {
        subs.add(cb);
        return () => subs.delete(cb);
      },
      requestCompile: () => {
        calls++;
        return new Promise<unknown>((resolve, reject) => {
          pending.push({ resolve, reject });
        });
      },
    },
    update,
    ackQueued: () => settle({ queued: true, accepted: true, editorIdleMs: 0 }),
    ackLegacy: () => settle({ ok: true }),
    rejectCompile: () => settle(undefined, true),
    refreshRan: async (compiling = false) => {
      ran += 1;
      await update({ refreshCompletedAt: ran, refreshCompiling: compiling });
    },
    compileCalls: () => calls,
  };
}

describe('waitForCompileReport', () => {
  it('resolves with the report when a fresh lastCompilation lands', async () => {
    const h = makeHarness();
    const p = waitForCompileReport(h.io, { timers: h.timers });
    await h.ackQueued();
    const r = report();
    await h.update({ isCompiling: true });
    await h.update({ isCompiling: false, lastCompilation: r });
    expect(await p).toEqual({ status: 'report', report: r });
  });

  it('still resolves with the report when requestCompile REJECTS first (reload flap)', async () => {
    const h = makeHarness();
    const p = waitForCompileReport(h.io, { timers: h.timers });
    await h.rejectCompile();
    const r = report();
    await h.update({ lastCompilation: r });
    expect(await p).toEqual({ status: 'report', report: r });
  });

  it('retries requestCompile once when rejected while still connected with no activity', async () => {
    const h = makeHarness();
    const p = waitForCompileReport(h.io, { timers: h.timers });
    await h.rejectCompile();
    await h.timers.advance(PROBE_MS);
    expect(h.compileCalls()).toBe(2);
    await h.ackQueued();
    const r = report();
    await h.update({ lastCompilation: r });
    expect(await p).toEqual({ status: 'report', report: r });
  });

  it('resolves bridge-lost when rejected, disconnected, and no activity for the probe window', async () => {
    const h = makeHarness();
    const p = waitForCompileReport(h.io, { timers: h.timers });
    await h.rejectCompile();
    await h.update({ connected: false, bridgeState: 'disconnected' });
    await h.timers.advance(PROBE_MS);
    expect(await p).toEqual({ status: 'unknown', reason: 'bridge-lost' });
  });

  // ── The queued-ack contract ────────────────────────────────────────────────
  //
  // A queued command is answered when it is ACCEPTED, not when it has run. The
  // whole bug this file guards against was treating the two as the same thing.

  it('does NOT call no-compile off the queued ack alone', async () => {
    const h = makeHarness();
    const p = waitForCompileReport(h.io, { timers: h.timers });
    await h.ackQueued();
    // Long past the quiet window, but Unity has not said the import ran, so
    // "nothing needed compiling" is not a claim we are entitled to make.
    await h.timers.advance(NO_COMPILE_QUIET_MS * 3);
    const r = report();
    await h.update({ lastCompilation: r });
    expect(await p).toEqual({ status: 'report', report: r });
  });

  it('resolves no-compile once the import really ran and nothing compiled', async () => {
    const h = makeHarness();
    const p = waitForCompileReport(h.io, { timers: h.timers });
    await h.ackQueued();
    await h.refreshRan();
    await h.timers.advance(NO_COMPILE_QUIET_MS);
    expect(await p).toEqual({ status: 'no-compile' });
  });

  it('accepts a legacy blocking reply as proof the import already ran', async () => {
    const h = makeHarness();
    const p = waitForCompileReport(h.io, { timers: h.timers });
    // A pre-queue package replies only after AssetDatabase.Refresh() returns,
    // so its ack IS the completion signal and must still arm the quiet window.
    await h.ackLegacy();
    await h.timers.advance(NO_COMPILE_QUIET_MS);
    expect(await p).toEqual({ status: 'no-compile' });
  });

  it('does NOT resolve no-compile once compile activity was seen; times out honestly instead', async () => {
    const h = makeHarness();
    const p = waitForCompileReport(h.io, { timers: h.timers });
    await h.ackQueued();
    await h.refreshRan();
    await h.update({ isCompiling: true });
    await h.timers.advance(NO_COMPILE_QUIET_MS);
    // still pending — advance to the overall cap
    await h.timers.advance(OVERALL_TIMEOUT_MS);
    expect(await p).toEqual({ status: 'unknown', reason: 'timeout' });
  });

  // ── The parked editor ──────────────────────────────────────────────────────

  it('resolves editor-asleep when Unity stays parked with nothing happening', async () => {
    const h = makeHarness({ editorAwake: false });
    const p = waitForCompileReport(h.io, { timers: h.timers });
    await h.ackQueued();
    await h.timers.advance(EDITOR_ASLEEP_GRACE_MS);
    // Fast and honest beats ninety seconds of silence followed by a shrug.
    expect(await p).toEqual({ status: 'unknown', reason: 'editor-asleep', canWake: true });
  });

  it('does not resolve editor-asleep if the nudge wakes Unity inside the grace window', async () => {
    const h = makeHarness({ editorAwake: false });
    const p = waitForCompileReport(h.io, { timers: h.timers });
    await h.ackQueued();
    await h.timers.advance(EDITOR_ASLEEP_GRACE_MS / 2);
    await h.update({ editorAwake: true });
    await h.timers.advance(EDITOR_ASLEEP_GRACE_MS);
    const r = report();
    await h.update({ lastCompilation: r });
    expect(await p).toEqual({ status: 'report', report: r });
  });

  it('never reports editor-asleep for a pump parked by a long import', async () => {
    const h = makeHarness();
    const p = waitForCompileReport(h.io, { timers: h.timers });
    await h.ackQueued();
    // A compile blocks the main thread too, so `awake` goes false for a reason
    // that is the opposite of idle. Activity already seen must win.
    await h.update({ isCompiling: true });
    await h.update({ editorAwake: false });
    await h.timers.advance(EDITOR_ASLEEP_GRACE_MS * 2);
    const r = report();
    await h.update({ isCompiling: false, lastCompilation: r });
    expect(await p).toEqual({ status: 'report', report: r });
  });

  it('will NOT call no-compile off silence from an editor that is parked', async () => {
    // The sharpest lie this module can tell. Unity does not begin compiling
    // inside Refresh(); it schedules the work for a later tick, and a
    // backgrounded editor has no later tick. So silence after the import means
    // "parked", not "nothing to build" — and answering no-compile told the
    // agent its change built clean when Unity had not looked at it.
    const h = makeHarness({ editorAwake: false });
    const p = waitForCompileReport(h.io, { timers: h.timers });
    await h.ackQueued();
    await h.refreshRan(); // import really ran, but the editor is still parked
    await h.timers.advance(NO_COMPILE_QUIET_MS * 3);
    expect(await p).toEqual({ status: 'unknown', reason: 'editor-asleep', canWake: true });
  });

  it('calls no-compile once the import ran AND the editor is provably ticking', async () => {
    const h = makeHarness({ editorAwake: true });
    const p = waitForCompileReport(h.io, { timers: h.timers });
    await h.ackQueued();
    await h.refreshRan();
    await h.timers.advance(NO_COMPILE_QUIET_MS + 1);
    expect(await p).toEqual({ status: 'no-compile' });
  });

  it('waits for the report when the import says a compile is already in flight', async () => {
    // Positive evidence from Unity outranks the quiet window: a compile it has
    // already started cannot be "nothing to build", however quiet things go.
    const h = makeHarness({ editorAwake: true });
    const p = waitForCompileReport(h.io, { timers: h.timers });
    await h.ackQueued();
    await h.refreshRan(true);
    await h.timers.advance(NO_COMPILE_QUIET_MS * 2);
    const r = report();
    await h.update({ lastCompilation: r });
    expect(await p).toEqual({ status: 'report', report: r });
  });

  it('accumulates sleep across wake flickers instead of restarting the countdown', async () => {
    // A backgrounded editor ticking slowly sits right on the package's awake
    // threshold, so heartbeats alternate. Re-arming on every flicker meant the
    // countdown never completed and the fast answer degraded to the 90s cap.
    const h = makeHarness({ editorAwake: false });
    let outcome: CompileWaitOutcome | null = null;
    void waitForCompileReport(h.io, { timers: h.timers }).then((o) => (outcome = o));
    await h.ackQueued();
    // 2s heartbeats, half of them awake: ~16s of wall clock to bank 8s asleep.
    for (let i = 0; i < 10 && outcome === null; i++) {
      await h.timers.advance(2000);
      await h.update({ editorAwake: i % 2 === 0 });
    }
    // Cast: TS cannot see the assignment inside the .then callback.
    expect(outcome as CompileWaitOutcome | null).toEqual({
      status: 'unknown',
      reason: 'editor-asleep',
      canWake: true,
    });
  });

  it('reports canWake:false so the caller can say "focus Unity" instead of "wait"', async () => {
    const h = makeHarness({ editorAwake: false, editorCanWake: false });
    const p = waitForCompileReport(h.io, { timers: h.timers });
    await h.ackQueued();
    await h.timers.advance(EDITOR_ASLEEP_GRACE_MS);
    expect(await p).toEqual({ status: 'unknown', reason: 'editor-asleep', canWake: false });
  });

  it('treats bridgeState reloading as activity (no bridge-lost during a domain reload)', async () => {
    const h = makeHarness();
    const p = waitForCompileReport(h.io, { timers: h.timers });
    await h.rejectCompile();
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
    await h.ackQueued();
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
    expect(h.compileCalls()).toBe(0);
  });

  it('ignores a stale pre-existing lastCompilation object (identity-fresh only)', async () => {
    const stale = report();
    const h = makeHarness({ lastCompilation: stale });
    const p = waitForCompileReport(h.io, { timers: h.timers });
    await h.ackQueued();
    // Same identity re-set: not fresh.
    await h.update({ isCompiling: true });
    const fresh = report();
    await h.update({ isCompiling: false, lastCompilation: fresh });
    const out = await p;
    expect(out.status).toBe('report');
    if (out.status === 'report') expect(out.report).toBe(fresh);
  });
});
