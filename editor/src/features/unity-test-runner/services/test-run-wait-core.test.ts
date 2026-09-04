import { describe, it, expect } from 'bun:test';
import {
  waitForTestRun,
  PROBE_MS,
  EDIT_MODE_TIMEOUT_MS,
  type TestRunWaitIo,
  type TestRunWaitSnap,
  type TestRunWaitTimers,
  type TestRunWaitOutcome,
} from './test-run-wait-core';
import { EDITOR_ASLEEP_GRACE_MS } from '../../../utils/sleep-accounting';
import type { TestRunCompletedPayload } from '../../../types/unity';

/** Manual timer fake: fire timers by advancing a virtual clock. Mirrors compile-wait-core.test.ts's. */
class FakeTimers implements TestRunWaitTimers {
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
      await Promise.resolve();
    }
    this.clock = target;
    await Promise.resolve();
  }
}

interface Harness {
  io: TestRunWaitIo;
  timers: FakeTimers;
  update(patch: Partial<TestRunWaitSnap>): Promise<void>;
  ackQueued(): Promise<void>;
  /** Resolve the request the way a pre-protocol-4 package with a working framework does. */
  ackLegacy(): Promise<void>;
  /** Resolve the request the way the framework-absent stub / an old package does. */
  ackNotInstalled(): Promise<void>;
  rejectRequest(): Promise<void>;
  requestCalls(): number;
}

function makeHarness(initial?: Partial<TestRunWaitSnap>): Harness {
  let snap: TestRunWaitSnap = {
    connected: true,
    bridgeState: 'connected',
    editorAwake: true,
    editorCanWake: true,
    bridgeProtocol: 4,
    lastRunCompleted: null,
    run: null,
    results: new Map(),
    ...initial,
  };
  const subs = new Set<(s: TestRunWaitSnap, p: TestRunWaitSnap) => void>();
  const pending: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];
  let calls = 0;
  const timers = new FakeTimers();

  const update = async (patch: Partial<TestRunWaitSnap>) => {
    const prev = snap;
    snap = { ...snap, ...patch };
    for (const cb of subs) cb(snap, prev);
    await Promise.resolve();
  };

  const settle = async (v: unknown, fail?: boolean) => {
    const p = pending.shift();
    if (fail) p?.reject(new Error('RPC rejected'));
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
      requestRunTests: () => {
        calls++;
        return new Promise<unknown>((resolve, reject) => {
          pending.push({ resolve, reject });
        });
      },
    },
    update,
    ackQueued: () => settle({ queued: true, accepted: true, editorIdleMs: 0 }),
    ackLegacy: () => settle({ ok: true }),
    ackNotInstalled: () => settle({ ok: false, error: 'Unity Test Framework is not installed.' }),
    rejectRequest: () => settle(undefined, true),
    requestCalls: () => calls,
  };
}

function completed(overrides: Partial<TestRunCompletedPayload> = {}): TestRunCompletedPayload {
  return {
    runId: 'run-1',
    ok: true,
    mode: 'EditMode',
    total: 3,
    passed: 2,
    failed: 1,
    skipped: 0,
    inconclusive: 0,
    durationMs: 500,
    failures: [
      { fullName: 'Foo.Bar', status: 'Failed', message: 'boom', stackTrace: '', durationMs: 10 },
    ],
    failuresTruncated: false,
    ...overrides,
  };
}

describe('waitForTestRun', () => {
  // ── The protocol-4 completed push ────────────────────────────────────────

  it('resolves report once test_run_completed with the matching runId lands', async () => {
    const h = makeHarness();
    const p = waitForTestRun(h.io, { runId: 'run-1', timers: h.timers });
    await h.ackQueued();
    await h.update({ run: { active: true, mode: 'EditMode', runId: 'run-1', total: 3, passed: 0, failed: 0 } });
    const summary = completed();
    await h.update({ lastRunCompleted: summary });
    expect(await p).toEqual({ status: 'report', summary });
  });

  it('ignores a completed push for a DIFFERENT runId', async () => {
    const h = makeHarness();
    const p = waitForTestRun(h.io, { runId: 'run-1', timers: h.timers });
    await h.ackQueued();
    await h.update({ lastRunCompleted: completed({ runId: 'someone-elses-run' }) });
    // still pending — the mismatched push must not resolve it
    await h.timers.advance(1000);
    const summary = completed({ runId: 'run-1' });
    await h.update({ lastRunCompleted: summary });
    expect(await p).toEqual({ status: 'report', summary });
  });

  it('resolves nothing-matched when the completed run reports zero total, not success', async () => {
    const h = makeHarness();
    const p = waitForTestRun(h.io, { runId: 'run-1', timers: h.timers });
    await h.ackQueued();
    const summary = completed({ total: 0, passed: 0, failed: 0, failures: [] });
    await h.update({ lastRunCompleted: summary });
    expect(await p).toEqual({ status: 'unknown', reason: 'nothing-matched' });
  });

  it('resolves report (not nothing-matched) for an ok:false completion, even with total undefined', async () => {
    const h = makeHarness();
    const p = waitForTestRun(h.io, { runId: 'run-1', timers: h.timers });
    await h.ackQueued();
    const summary: TestRunCompletedPayload = { runId: 'run-1', ok: false, reason: 'runner-unavailable' };
    await h.update({ lastRunCompleted: summary });
    expect(await p).toEqual({ status: 'report', summary });
  });

  // ── The legacy (protocol < 4) fallback ───────────────────────────────────

  it('resolves report via the legacy run.active transition when the package predates protocol 4', async () => {
    const h = makeHarness({ bridgeProtocol: 3 });
    const p = waitForTestRun(h.io, { runId: 'run-1', mode: 'EditMode', timers: h.timers });
    await h.ackLegacy();

    await h.update({ run: { active: true, mode: 'EditMode', total: 2, passed: 0, failed: 0 } });
    // A test fails during the run — results map gains a 'failed' entry.
    await h.update({
      results: new Map([['Foo.Bar', { status: 'failed', message: 'boom', stackTrace: '', durationMs: 5 }]]),
    });
    await h.update({ run: { active: false, mode: 'EditMode', total: 2, passed: 1, failed: 1 } });

    const outcome = await p;
    expect(outcome.status).toBe('report');
    if (outcome.status === 'report') {
      expect(outcome.summary.runId).toBeNull();
      expect(outcome.summary.ok).toBe(true);
      expect(outcome.summary.passed).toBe(1);
      expect(outcome.summary.failed).toBe(1);
      expect(outcome.summary.failures?.[0]?.fullName).toBe('Foo.Bar');
      // Genuinely unknown on the legacy path — must not be guessed.
      expect(outcome.summary.skipped).toBeUndefined();
    }
  });

  it('legacy fallback excludes a result that was ALREADY failed before this request (baseline)', async () => {
    const h = makeHarness({
      bridgeProtocol: 3,
      results: new Map([['Stale.Test', { status: 'failed', message: 'old failure', stackTrace: '', durationMs: 1 }]]),
    });
    const p = waitForTestRun(h.io, { runId: 'run-1', mode: 'EditMode', timers: h.timers });
    await h.ackLegacy();
    await h.update({ run: { active: true, mode: 'EditMode', total: 1, passed: 0, failed: 0 } });
    await h.update({ run: { active: false, mode: 'EditMode', total: 1, passed: 1, failed: 0 } });

    const outcome = await p;
    expect(outcome.status).toBe('report');
    if (outcome.status === 'report') {
      expect(outcome.summary.failures).toEqual([]);
    }
  });

  // ── Overall timeout ───────────────────────────────────────────────────────

  it('resolves timeout honestly once the overall cap elapses with no signal', async () => {
    const h = makeHarness();
    const p = waitForTestRun(h.io, { runId: 'run-1', timers: h.timers });
    await h.ackQueued();
    await h.timers.advance(EDIT_MODE_TIMEOUT_MS);
    expect(await p).toEqual({ status: 'unknown', reason: 'timeout' });
  });

  // ── Abort ─────────────────────────────────────────────────────────────────

  it('resolves aborted on signal abort and stops listening', async () => {
    const h = makeHarness();
    const ctrl = new AbortController();
    const p = waitForTestRun(h.io, { runId: 'run-1', timers: h.timers, signal: ctrl.signal });
    await h.ackQueued();
    ctrl.abort();
    expect(await p).toEqual({ status: 'unknown', reason: 'aborted' });
    // A push arriving after abort must not throw or change the settled result.
    await h.update({ lastRunCompleted: completed() });
  });

  it('resolves aborted immediately when the signal is already aborted', async () => {
    const h = makeHarness();
    const ctrl = new AbortController();
    ctrl.abort();
    const p = waitForTestRun(h.io, { runId: 'run-1', timers: h.timers, signal: ctrl.signal });
    expect(await p).toEqual({ status: 'unknown', reason: 'aborted' });
    expect(h.requestCalls()).toBe(0);
  });

  // ── The parked editor ──────────────────────────────────────────────────────

  it('resolves editor-asleep when Unity stays parked with no runStarted', async () => {
    const h = makeHarness({ editorAwake: false });
    const p = waitForTestRun(h.io, { runId: 'run-1', timers: h.timers });
    await h.ackQueued();
    await h.timers.advance(EDITOR_ASLEEP_GRACE_MS);
    expect(await p).toEqual({ status: 'unknown', reason: 'editor-asleep', canWake: true });
  });

  it('reports canWake:false so the caller can say "focus Unity" instead of "wait"', async () => {
    const h = makeHarness({ editorAwake: false, editorCanWake: false });
    const p = waitForTestRun(h.io, { runId: 'run-1', timers: h.timers });
    await h.ackQueued();
    await h.timers.advance(EDITOR_ASLEEP_GRACE_MS);
    expect(await p).toEqual({ status: 'unknown', reason: 'editor-asleep', canWake: false });
  });

  it('never reports editor-asleep once the run has started, even if the editor parks mid-run', async () => {
    const h = makeHarness();
    const p = waitForTestRun(h.io, { runId: 'run-1', timers: h.timers });
    await h.ackQueued();
    await h.update({ run: { active: true, mode: 'EditMode', runId: 'run-1', total: 1, passed: 0, failed: 0 } });
    await h.update({ editorAwake: false });
    await h.timers.advance(EDITOR_ASLEEP_GRACE_MS * 3);
    const summary = completed();
    await h.update({ lastRunCompleted: summary });
    expect(await p).toEqual({ status: 'report', summary });
  });

  it('treats a domain reload as activity — no false editor-asleep mid-PlayMode-run', async () => {
    const h = makeHarness();
    const p = waitForTestRun(h.io, { runId: 'run-1', mode: 'PlayMode', timers: h.timers });
    await h.ackQueued();
    await h.update({ bridgeState: 'reloading', editorAwake: false });
    await h.timers.advance(EDITOR_ASLEEP_GRACE_MS * 2);
    const summary = completed({ mode: 'PlayMode' });
    await h.update({ bridgeState: 'connected', lastRunCompleted: summary });
    expect(await p).toEqual({ status: 'report', summary });
  });

  // ── Bridge lost ───────────────────────────────────────────────────────────

  it('resolves bridge-lost when the request is rejected, the bridge disconnects, and nothing else happens', async () => {
    const h = makeHarness();
    const p = waitForTestRun(h.io, { runId: 'run-1', timers: h.timers });
    await h.rejectRequest();
    await h.update({ connected: false, bridgeState: 'disconnected' });
    await h.timers.advance(PROBE_MS);
    expect(await p).toEqual({ status: 'unknown', reason: 'bridge-lost' });
  });

  it('resolves timeout (not bridge-lost) when rejected but still connected', async () => {
    const h = makeHarness();
    const p = waitForTestRun(h.io, { runId: 'run-1', timers: h.timers });
    await h.rejectRequest();
    await h.timers.advance(PROBE_MS);
    expect(await p).toEqual({ status: 'unknown', reason: 'timeout' });
  });

  // ── Not installed ─────────────────────────────────────────────────────────

  it('resolves not-installed on a synchronous {ok:false} ack — nothing is ever going to complete this run', async () => {
    const h = makeHarness();
    const p = waitForTestRun(h.io, { runId: 'run-1', timers: h.timers });
    await h.ackNotInstalled();
    expect(await p).toEqual({ status: 'unknown', reason: 'not-installed' });
  });

  // ── Defaults ──────────────────────────────────────────────────────────────

  it('defaults to a 5 minute cap for EditMode', async () => {
    const h = makeHarness();
    const p = waitForTestRun(h.io, { runId: 'run-1', mode: 'EditMode', timers: h.timers });
    await h.ackQueued();
    await h.timers.advance(EDIT_MODE_TIMEOUT_MS - 1);
    let outcome: TestRunWaitOutcome | null = null;
    void p.then((o) => (outcome = o));
    await Promise.resolve();
    expect(outcome).toBeNull();
    await h.timers.advance(1);
    expect(await p).toEqual({ status: 'unknown', reason: 'timeout' });
  });

  it('defaults to a 15 minute cap for PlayMode', async () => {
    const h = makeHarness();
    const p = waitForTestRun(h.io, { runId: 'run-1', mode: 'PlayMode', timers: h.timers });
    await h.ackQueued();
    await h.timers.advance(EDIT_MODE_TIMEOUT_MS);
    let outcome: TestRunWaitOutcome | null = null;
    void p.then((o) => (outcome = o));
    await Promise.resolve();
    expect(outcome).toBeNull(); // still running well past the EditMode cap
    await h.timers.advance(10 * 60_000 + 1);
    expect(await p).toEqual({ status: 'unknown', reason: 'timeout' });
  });

  it('an explicit timeoutMs overrides the per-mode default', async () => {
    const h = makeHarness();
    const p = waitForTestRun(h.io, { runId: 'run-1', mode: 'PlayMode', timers: h.timers, timeoutMs: 1_000 });
    await h.ackQueued();
    await h.timers.advance(1_000);
    expect(await p).toEqual({ status: 'unknown', reason: 'timeout' });
  });
});
