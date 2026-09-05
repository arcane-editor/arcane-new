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
      reason:
        | 'timeout'
        | 'aborted'
        | 'bridge-lost'
        | 'editor-asleep'
        | 'not-installed'
        | 'nothing-matched'
        | 'runner-unavailable';
      /** For `editor-asleep` only — see `compile-wait-core.ts`'s `CompileWaitOutcome`. */
      canWake?: boolean;
      /**
       * `reason:'timeout'` only: the queued ack said `accepted:false` — this
       * ask was coalesced behind an identical one already pending, so the
       * timeout may just mean the pending ask itself is still running, not
       * that anything is actually stuck.
       */
      coalesced?: boolean;
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
    /** A `runStarted` (or, legacy, a genuine rising edge) was observed for THIS request. */
    let activitySeen = false;
    /**
     * Legacy fallback only: has `run.active` risen true→false→…, where the
     * RISE happened after our own request was ACCEPTED (not merely present
     * at baseline). Without gating on acceptance, a run that was already
     * active when this wait started (or a DIFFERENT one that starts while
     * ours was refused) gets mistaken for this request's — see F1 in the
     * task-11 review: reviewer drove "prior run active, our RPC rejected"
     * and got the OTHER run's results reported as this one's.
     */
    let legacySeenActive = false;
    /** Legacy fallback only: did `io.requestRunTests()` resolve (not reject)? Gates `legacySeenActive`. */
    let requestAccepted = false;
    /** `{queued:true, accepted:false}` — this ask was coalesced behind an identical pending one. */
    let coalesced: boolean | undefined;
    const handles: unknown[] = [];
    let unsub: (() => void) | null = null;
    let onAbort: (() => void) | null = null;

    const start = io.getSnap();
    const legacy = (start.bridgeProtocol ?? 0) < MIN_COMPLETED_PUSH_PROTOCOL;
    /** Whether a run was ALREADY active before this request even began — see F1. */
    const priorRunActive = start.run?.active === true;
    /** Legacy fallback only: fullNames already `failed` before this request — see `buildLegacySummary`. */
    const legacyFailedBaseline = new Set<string>();
    if (legacy) {
      for (const [name, r] of start.results) {
        if (r.status === 'failed') legacyFailedBaseline.add(name);
      }
    }

    // Already disconnected before we even asked — the 5-15 minute cap is far
    // too long to sit on a bridge that is provably not there (M4).
    if (!start.connected) {
      resolve({ status: 'unknown', reason: 'bridge-lost' });
      return;
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
        // The REQUESTED mode, not `run?.mode` — test-store defaults a
        // `runStarted` event's echoed mode to 'EditMode' whenever the push
        // omits it, which would silently override an accurate PlayMode
        // request with a wrong default (M1).
        mode,
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

    /** Protocol4 only: whether `snap.run` is plausibly THIS request's run (matched by id). */
    const isMyRunActive = (snap: TestRunWaitSnap): boolean => {
      if (legacy) return false; // legacy has no runId to match — see the edge tracking below
      if (!snap.run || !snap.run.active) return false;
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
    unsub = io.subscribe((snap, prev) => {
      // A dead bridge cannot possibly finish this run, whatever else is true
      // — resolve promptly rather than sitting out the full cap (M4).
      if (!snap.connected) {
        finish({ status: 'unknown', reason: 'bridge-lost' });
        return;
      }

      // A domain reload (PlayMode) is exactly the kind of "editor busy" that
      // must not read as a parked, do-nothing editor.
      if (snap.bridgeState === 'reloading') activitySeen = true;

      if (snap.lastRunCompleted && snap.lastRunCompleted.runId === runId) {
        activitySeen = true;
        resolveSummary(snap.lastRunCompleted);
        return;
      }

      if (legacy) {
        // Only a RISING edge observed AFTER our own request was accepted
        // counts as "our run started" — a run that was already active (or a
        // different one starting while ours was refused) must never be
        // mistaken for this request's (F1).
        const wasActive = prev.run?.active === true;
        const isActive = snap.run?.active === true;
        if (requestAccepted && !legacySeenActive && !wasActive && isActive) {
          legacySeenActive = true;
          activitySeen = true;
        } else if (legacySeenActive && wasActive && !isActive) {
          resolveSummary(buildLegacySummary(snap));
          return;
        }
      } else if (isMyRunActive(snap)) {
        activitySeen = true;
      }

      checkSleep(snap);
    });

    if (signal) {
      onAbort = () => finish({ status: 'unknown', reason: 'aborted' });
      signal.addEventListener('abort', onAbort, { once: true });
    }

    arm(() => finish({ status: 'unknown', reason: 'timeout', coalesced }), timeoutMs);

    io.requestRunTests().then(
      (reply) => {
        if (settled) return;
        // A synchronous `{ok:false}` ack means the framework/runner is not
        // even present to start a run — nothing is ever going to complete
        // this wait, so say so now rather than waiting it out.
        if (isNotInstalledReply(reply)) {
          finish({ status: 'unknown', reason: 'not-installed' });
          return;
        }
        if (isCoalescedAck(reply)) {
          // Accepted, but folded into an identical ask already pending —
          // still going to complete (or time out) normally; just remember it
          // for the eventual outcome's copy (M3).
          coalesced = true;
        }
        // The ask was genuinely ACCEPTED (or a legacy package's synchronous
        // `{ok:true}`, whose own `test_event` stream is already being
        // watched above) — only NOW may a legacy rising edge be trusted as
        // ours (see the subscribe handler).
        requestAccepted = true;
      },
      (err) => {
        if (settled) return;
        // Unity refused because a run was already in progress — this ask
        // never started and nothing will ever complete it, so say so
        // immediately rather than waiting out the probe window (F1).
        if (looksLikeRunnerBusy(err) || (legacy && priorRunActive)) {
          finish({ status: 'unknown', reason: 'runner-unavailable' });
          return;
        }
        // Any other rejection ≠ the run didn't happen — watch for activity
        // briefly before deciding anything, same reasoning as
        // compile-wait-core.
        arm(() => {
          if (settled || activitySeen) return;
          if (!io.getSnap().connected) {
            finish({ status: 'unknown', reason: 'bridge-lost' });
          } else {
            finish({ status: 'unknown', reason: 'timeout', coalesced });
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

/** True for the `{queued:true, accepted:false}` ack — coalesced behind an identical pending ask. */
function isCoalescedAck(reply: unknown): boolean {
  return (
    typeof reply === 'object' &&
    reply !== null &&
    (reply as { queued?: unknown }).queued === true &&
    (reply as { accepted?: unknown }).accepted === false
  );
}

/**
 * True when a rejection's message says Unity refused because a run was
 * already in progress — the phrasing the reviewer's repro used ("a test run
 * is already in progress") and the realistic shape of `TestRunnerApi.Execute()`
 * throwing on a legacy (pre-queue) package, which has no try/catch of its own
 * around that call.
 */
function looksLikeRunnerBusy(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err ?? '');
  return /already\s+(in\s+progress|running)/i.test(text);
}
