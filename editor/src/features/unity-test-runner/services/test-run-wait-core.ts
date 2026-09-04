// Pure test-run-wait state machine — mirrors
// `unity-bridge/services/compile-wait-core.ts` exactly, for the same reason: a
// queued `runTests` RPC only ever means "accepted", never "done", so the
// caller needs a state machine that resolves on the run's REAL completion
// (`test_run_completed`, matched by `runId`) rather than trusting the ack —
// and is honest about every way that can go wrong instead of hanging the
// whole overall timeout. See `services/test-run-wait.ts` for the store/RPC
// wiring, and `compile-wait-core.ts`'s own header for the fuller rationale
// this shares.
//
// PROTOCOL-3 FALLBACK: a Unity package that predates `test_run_completed`
// (bridgeProtocol < 4) never sends it, so this falls back to the legacy
// signal — `test-store`'s `run.active` flipping true→false — and reconstructs
// a best-effort summary from `run` and the `results` diff since the request
// began. It is honest about being degraded: no `skipped`/`durationMs`, since
// the legacy path genuinely does not know them (`test-store`'s `RunState`
// never tracked them, and guessing would be exactly the kind of lie this file
// exists to avoid).

// `utils/sleep-accounting.ts`, not `unity-bridge`'s barrel: that barrel also
// re-exports React components (BridgeInstallBanner etc.) whose own transitive
// imports reach Monaco and `window`, which would break this file's (and its
// test's) direct Bun-testability. See compile-wait-core.ts's own note.
import { createSleepTracker, EDITOR_ASLEEP_GRACE_MS, type SleepTimers } from '../../../utils/sleep-accounting';
import type { TestRunCompletedPayload, TestRunFailure } from '../../../types/unity';

export type TestMode = 'EditMode' | 'PlayMode';

/** What a wait resolved to. Every branch is honest — no fake success. */
export type TestRunWaitOutcome =
  | { status: 'report'; summary: TestRunCompletedPayload }
  | {
      status: 'unknown';
      reason: 'timeout' | 'aborted' | 'bridge-lost' | 'editor-asleep' | 'not-installed' | 'nothing-matched';
      /** For `editor-asleep` only — see `compile-wait-core.ts`'s `CompileWaitOutcome`. */
      canWake?: boolean;
    };

export interface TestRunWaitResultSnap {
  status: string;
  message?: string;
  stackTrace?: string;
  durationMs?: number;
}

/** The slice of `test-store`'s live `run` the machine observes. */
export interface TestRunWaitRunSnap {
  active: boolean;
  mode: TestMode;
  /** Absent for a pre-protocol-4 package, which never stamps one. */
  runId?: string;
  total: number;
  passed: number;
  failed: number;
}

/** The slice of store state the machine observes. */
export interface TestRunWaitSnap {
  connected: boolean;
  bridgeState: string;
  editorAwake: boolean;
  editorCanWake: boolean;
  /** The INSTALLED Unity package's own protocol version; null until known. */
  bridgeProtocol: number | null;
  lastRunCompleted: TestRunCompletedPayload | null;
  run: TestRunWaitRunSnap | null;
  results: ReadonlyMap<string, TestRunWaitResultSnap>;
}

export interface TestRunWaitIo {
  getSnap(): TestRunWaitSnap;
  /** Zustand-style: cb(next, prev) on every store change. Returns unsubscribe. */
  subscribe(cb: (snap: TestRunWaitSnap, prev: TestRunWaitSnap) => void): () => void;
  /** Ask Unity to run the tests this wait is watching for (mode/filter/runId already bound). */
  requestRunTests(): Promise<unknown>;
}

export type TestRunWaitTimers = SleepTimers;

const realTimers: TestRunWaitTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/** Below this, the package predates `test_run_completed` and the legacy fallback applies. */
const MIN_COMPLETED_PUSH_PROTOCOL = 4;

/** Default cap for an EditMode run — expected to be quick. */
export const EDIT_MODE_TIMEOUT_MS = 5 * 60_000;
/** Default cap for a PlayMode run — a domain reload plus real gameplay frames. */
export const PLAY_MODE_TIMEOUT_MS = 15 * 60_000;
/** After a REJECTED request: how long to watch for activity before giving up. */
export const PROBE_MS = 12_000;

function defaultTimeoutForMode(mode: TestMode): number {
  return mode === 'PlayMode' ? PLAY_MODE_TIMEOUT_MS : EDIT_MODE_TIMEOUT_MS;
}

export interface TestRunWaitOpts {
  runId: string;
  /** Defaults to `'EditMode'` — also picks the default timeout (see `defaultTimeoutForMode`). */
  mode?: TestMode;
  signal?: AbortSignal;
  timeoutMs?: number;
  timers?: TestRunWaitTimers;
}

export function waitForTestRun(io: TestRunWaitIo, opts: TestRunWaitOpts): Promise<TestRunWaitOutcome> {
  const { runId, mode = 'EditMode', signal, timers = realTimers } = opts;
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutForMode(mode);

  if (signal?.aborted) {
    return Promise.resolve({ status: 'unknown', reason: 'aborted' });
  }

  return new Promise<TestRunWaitOutcome>((resolve) => {
    let settled = false;
    /** A `runStarted` (or, legacy, `run.active`) was observed for this request. */
    let activitySeen = false;
    /** Legacy fallback only: has `run.active` gone true since this request began. */
    let legacySeenActive = false;
    const handles: unknown[] = [];
    let unsub: (() => void) | null = null;
    let onAbort: (() => void) | null = null;

    const start = io.getSnap();
    const legacy = (start.bridgeProtocol ?? 0) < MIN_COMPLETED_PUSH_PROTOCOL;
    /** Legacy fallback only: fullNames already `failed` before this request — see `buildLegacySummary`. */
    const legacyFailedBaseline = new Set<string>();
    if (legacy) {
      for (const [name, r] of start.results) {
        if (r.status === 'failed') legacyFailedBaseline.add(name);
      }
    }

    const finish = (outcome: TestRunWaitOutcome) => {
      if (settled) return;
      settled = true;
      for (const h of handles) timers.clear(h);
      sleep.clear();
      unsub?.();
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };

    const sleep = createSleepTracker({
      timers,
      graceMs: EDITOR_ASLEEP_GRACE_MS,
      onAsleep: () => {
        if (settled || activitySeen) return;
        finish({ status: 'unknown', reason: 'editor-asleep', canWake: io.getSnap().editorCanWake });
      },
    });

    const arm = (fn: () => void, ms: number) => {
      handles.push(timers.set(fn, ms));
    };

    /** A completed summary with zero tests means the filter matched nothing — not success. */
    const resolveSummary = (summary: TestRunCompletedPayload) => {
      if (summary.ok && (summary.total ?? 0) === 0) {
        finish({ status: 'unknown', reason: 'nothing-matched' });
        return;
      }
      finish({ status: 'report', summary });
    };

    const buildLegacySummary = (snap: TestRunWaitSnap): TestRunCompletedPayload => {
      const run = snap.run;
      const failures: TestRunFailure[] = [];
      for (const [fullName, r] of snap.results) {
        if (r.status === 'failed' && !legacyFailedBaseline.has(fullName)) {
          failures.push({
            fullName,
            status: r.status,
            message: r.message ?? '',
            stackTrace: r.stackTrace ?? '',
            durationMs: r.durationMs ?? 0,
          });
        }
      }
      return {
        runId: null, // the legacy package never stamped one
        ok: true,
        mode: run?.mode ?? mode,
        total: run?.total,
        passed: run?.passed,
        failed: run?.failed,
        // Genuinely unknown on this path — test-store's legacy RunState never
        // tracked them, and a guess here is exactly the lie this file exists
        // to avoid.
        skipped: undefined,
        durationMs: undefined,
        failures,
        failuresTruncated: false,
      };
    };

    /** Whether `snap.run` is plausibly THIS request's run (protocol4: match by id; legacy: any active run). */
    const isMyRunActive = (snap: TestRunWaitSnap): boolean => {
      if (!snap.run || !snap.run.active) return false;
      if (legacy) return true;
      return snap.run.runId == null || snap.run.runId === runId;
    };

    const checkSleep = (snap: TestRunWaitSnap) => {
      if (settled || activitySeen) {
        sleep.clear();
        return;
      }
      sleep.update(snap.editorAwake);
    };

    // Listen FIRST, so a fast run can't finish before we're watching.
    unsub = io.subscribe((snap) => {
      // A domain reload (PlayMode) is exactly the kind of "editor busy" that
      // must not read as a parked, do-nothing editor.
      if (snap.bridgeState === 'reloading') activitySeen = true;

      if (snap.lastRunCompleted && snap.lastRunCompleted.runId === runId) {
        activitySeen = true;
        resolveSummary(snap.lastRunCompleted);
        return;
      }

      if (isMyRunActive(snap)) {
        activitySeen = true;
        legacySeenActive = true;
      } else if (legacy && legacySeenActive && snap.run && !snap.run.active) {
        resolveSummary(buildLegacySummary(snap));
        return;
      }

      checkSleep(snap);
    });

    if (signal) {
      onAbort = () => finish({ status: 'unknown', reason: 'aborted' });
      signal.addEventListener('abort', onAbort, { once: true });
    }

    arm(() => finish({ status: 'unknown', reason: 'timeout' }), timeoutMs);

    io.requestRunTests().then(
      (reply) => {
        if (settled) return;
        // A synchronous `{ok:false}` ack means the framework/runner is not
        // even present to start a run — nothing is ever going to complete
        // this wait, so say so now rather than waiting it out.
        if (isNotInstalledReply(reply)) {
          finish({ status: 'unknown', reason: 'not-installed' });
        }
        // Otherwise: a `{queued:true}` ack (accepted, not done) or a legacy
        // package's synchronous `{ok:true}` (which streams its own
        // `test_event`s, already being watched above) — either way there is
        // nothing more to do with the reply itself.
      },
      () => {
        if (settled) return;
        // Rejection ≠ the run didn't happen — watch for activity briefly
        // before deciding anything, same reasoning as compile-wait-core.
        arm(() => {
          if (settled || activitySeen) return;
          if (!io.getSnap().connected) {
            finish({ status: 'unknown', reason: 'bridge-lost' });
          } else {
            finish({ status: 'unknown', reason: 'timeout' });
          }
        }, PROBE_MS);
      },
    );

    // The editor may already be parked, in which case no store change is
    // coming to trigger the check — start the clock now.
    checkSleep(start);
  });
}

/** True for the `{ok:false}` ack the framework-absent stub / an old package returns synchronously. */
function isNotInstalledReply(reply: unknown): boolean {
  return (
    typeof reply === 'object' && reply !== null && (reply as { ok?: unknown }).ok === false
  );
}
