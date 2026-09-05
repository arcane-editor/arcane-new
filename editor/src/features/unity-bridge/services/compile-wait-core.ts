// Pure compile-wait state machine — the store/RPC-free half of
// `triggerRecompileAndWait` (see compile-wait.ts for the wiring and for why
// this exists at all). Extracted behind the `CompileWaitIo` seam so the state
// machine is directly Bun-testable, mirroring the `HintLookup` /
// `DiagnosticsFetcher` DI pattern used by the ai-panel gates.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: never claim to know something about a
// compile that we do not know. There are three distinct ways to not know, and
// collapsing any two of them produces a specific, user-visible lie:
//
//   1. The RPC rejected. That is NOT "the compile didn't happen" — the ask
//      predictably fails at the exact moment a compile starts (the dispatcher
//      cancels waits on beforeAssemblyReload, the Rust side drains pending RPCs
//      on the reload flap). A rejection keeps the wait alive.
//
//   2. The command was ACCEPTED but has not run. Unity's refresh and compile
//      commands are queued now, because Unity parks its main thread whenever its
//      window is unfocused — which is the normal state while the user is looking
//      at this IDE. The ack means "queued", full stop. Arming the
//      "nothing needed compiling" timer off that ack was the sharpest version of
//      this bug: an unfocused Unity reported a clean no-op compile for a file it
//      had not so much as imported. `refreshCompletedAt` is the real signal.
//
//   3. The editor is parked and staying parked. Previously this burned the full
//      ninety-second cap and then shrugged. It now resolves quickly as
//      `editor-asleep`, which is both true and actionable — the caller can tell
//      the model its write landed and is waiting on Unity, rather than stalling
//      the turn on a window nobody is looking at.

import type { CompilationPayload } from '../../../types/unity';
// Shared with `unity-test-runner/services/test-run-wait-core.ts`, which lives
// in a DIFFERENT feature — hence `utils/`, not a feature-internal `services/`
// file, so both can import it without a cross-feature barrel hop (and without
// unity-bridge's own barrel, whose other exports pull in React/Monaco and
// would break the direct Bun-testability both wait-cores rely on).
import { createSleepTracker, EDITOR_ASLEEP_GRACE_MS } from '../../../utils/sleep-accounting';

export { EDITOR_ASLEEP_GRACE_MS } from '../../../utils/sleep-accounting';

/** What a compile wait resolved to. Every branch is honest — no fake success. */
export type CompileWaitOutcome =
  | { status: 'report'; report: CompilationPayload }
  /** The import ran and Unity had nothing to build. */
  | { status: 'no-compile' }
  | {
      status: 'unknown';
      reason: 'timeout' | 'bridge-lost' | 'aborted' | 'editor-asleep';
      /**
       * For `editor-asleep` only: whether the bridge can wake Unity without
       * stealing focus. False (Linux, or a P/Invoke that latched off) means
       * waiting will not help and the user has to focus Unity — different
       * advice, so the caller must be able to tell the two apart.
       */
      canWake?: boolean;
    };

/** The slice of unity-store state the machine observes. */
export interface UnitySnap {
  connected: boolean;
  bridgeState: string;
  isCompiling: boolean;
  lastCompilation: CompilationPayload | null;
  /**
   * Whether Unity's MAIN THREAD is servicing work, as opposed to whether its
   * process is alive. The bridge's worker thread heartbeats either way, so
   * `connected` alone cannot distinguish a working editor from a parked one.
   */
  editorAwake: boolean;
  /** Bumped each time Unity reports that a queued import actually executed. */
  refreshCompletedAt: number;
  /**
   * Whether Unity had a compile in flight at the moment that import finished.
   *
   * Positive evidence, and the thing that makes "nothing needed compiling"
   * safe to say. Silence cannot distinguish "no compile" from "a compile Unity
   * scheduled for a tick it has not run yet"; this can, in the case where the
   * compile has already started.
   */
  refreshCompiling: boolean;
  /** Whether Unity can be woken without stealing focus. */
  editorCanWake: boolean;
}

export interface CompileWaitIo {
  getSnap(): UnitySnap;
  /** Zustand-style: cb(next, prev) on every store change. Returns unsubscribe. */
  subscribe(cb: (snap: UnitySnap, prev: UnitySnap) => void): () => void;
  /**
   * Ask Unity to import and compile. Resolves with the bridge's reply: a
   * `{queued:true}` ack from a current package (accepted, not done), or any
   * other value from a pre-queue package, whose reply only arrives once the
   * import has actually finished.
   */
  requestCompile(): Promise<unknown>;
}

/** Injectable timers so tests drive the clock (defaults to real setTimeout). */
export interface CompileWaitTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  /** Monotonic-enough clock. Needed to ACCUMULATE sleep across wake flickers. */
  now(): number;
}

const realTimers: CompileWaitTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/**
 * Hard ceiling on the whole wait. Matches the Rust bridge's reload-widened
 * peer-dead window (`unity_ipc.rs` widens 8s → 90s while `reloading`): a big
 * project's import + compile + domain reload legitimately takes this long.
 */
export const OVERALL_TIMEOUT_MS = 90_000;
/** After the import REALLY RAN with zero compile activity: nothing to build. */
export const NO_COMPILE_QUIET_MS = 5_000;
/** After a REJECTED request: how long to watch for activity before acting. */
export const PROBE_MS = 12_000;
/** Retries after a rejection while still connected (the ask may have been swallowed by a reload flap). */
const MAX_REFRESH_RETRIES = 1;

export interface CompileWaitOpts {
  timeoutMs?: number;
  signal?: AbortSignal;
  timers?: CompileWaitTimers;
}

export function waitForCompileReport(
  io: CompileWaitIo,
  opts: CompileWaitOpts = {},
): Promise<CompileWaitOutcome> {
  const { timeoutMs = OVERALL_TIMEOUT_MS, signal, timers = realTimers } = opts;

  if (signal?.aborted) {
    return Promise.resolve({ status: 'unknown', reason: 'aborted' });
  }

  return new Promise<CompileWaitOutcome>((resolve) => {
    let settled = false;
    let activitySeen = false;
    /** The import provably executed — via refresh_completed or a legacy reply. */
    let importRan = false;
    let retriesLeft = MAX_REFRESH_RETRIES;
    const handles: unknown[] = [];
    let quietHandle: unknown = null;
    let unsub: (() => void) | null = null;
    let onAbort: (() => void) | null = null;

    const start = io.getSnap();
    const baseline = start.lastCompilation;
    const refreshBaseline = start.refreshCompletedAt;

    const finish = (outcome: CompileWaitOutcome) => {
      if (settled) return;
      settled = true;
      for (const h of handles) timers.clear(h);
      sleep.clear();
      clearQuietWindow();
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

    /**
     * The import provably ran. Compile activity reported alongside it settles
     * the question outright; otherwise the quiet window takes over, but only
     * while the editor is actually ticking.
     */
    const noteImportRan = (compiling: boolean) => {
      if (settled) return;
      importRan = true;
      if (compiling) {
        activitySeen = true;
        clearQuietWindow();
        return;
      }
      armQuietWindow();
    };

    const clearQuietWindow = () => {
      if (quietHandle === null) return;
      timers.clear(quietHandle);
      quietHandle = null;
    };

    /**
     * Start (or restart) the "nothing needed compiling" countdown.
     *
     * ONLY RUNS WHILE THE EDITOR IS AWAKE, and that is the fix for the sharpest
     * lie this file can tell. Unity does not begin compiling inside Refresh() —
     * it schedules the work for a later tick. On a backgrounded editor that tick
     * may never come, so five seconds of silence after the import means
     * "Unity is parked", not "there was nothing to build" — and reporting the
     * latter told the agent its change compiled clean when it had not been
     * looked at. A parked editor disarms the window; the sleep accounting below
     * answers instead.
     */
    const armQuietWindow = () => {
      if (settled || activitySeen || !importRan) return;
      if (quietHandle !== null) return;
      if (!io.getSnap().editorAwake) return;
      quietHandle = timers.set(() => {
        quietHandle = null;
        if (settled || activitySeen) return;
        // Re-check: the editor may have parked mid-window, in which case the
        // silence proves nothing and the sleep path owns the answer.
        if (!io.getSnap().editorAwake) return;
        finish({ status: 'no-compile' });
      }, NO_COMPILE_QUIET_MS);
    };

    /**
     * Track how long Unity's main thread has been parked, and answer
     * `editor-asleep` once it has been parked long enough to matter.
     *
     * Runs even after the import has landed: a parked editor with a compile it
     * has not started yet is precisely the case we must not call `no-compile`.
     * It stays inert once real compile activity is seen, because a compile
     * blocks the main thread too — `editorAwake` goes false during exactly the
     * work we are waiting for, and reading that as idleness would abandon a
     * compile that is running fine.
     */
    const evaluateSleep = (snap: UnitySnap) => {
      if (settled || activitySeen) {
        sleep.clear();
        return;
      }

      if (snap.editorAwake) {
        sleep.update(true);
        // Awake again and still nothing compiling: the quiet window can resume.
        armQuietWindow();
        return;
      }

      // Parked: a quiet window measured against a stopped editor is meaningless.
      clearQuietWindow();
      sleep.update(false);
    };

    // Listen FIRST, so a fast compile can't finish before we're watching.
    // Resolve only on a fresh `lastCompilation` object identity (the store
    // assigns a new object only on a finished payload — see stores/unity.ts).
    unsub = io.subscribe((snap) => {
      if (snap.isCompiling || snap.bridgeState === 'reloading') activitySeen = true;
      if (snap.refreshCompletedAt !== refreshBaseline && !importRan) {
        noteImportRan(snap.refreshCompiling);
      }
      if (snap.lastCompilation && snap.lastCompilation !== baseline) {
        activitySeen = true;
        finish({ status: 'report', report: snap.lastCompilation });
        return;
      }
      evaluateSleep(snap);
    });

    if (signal) {
      onAbort = () => finish({ status: 'unknown', reason: 'aborted' });
      signal.addEventListener('abort', onAbort, { once: true });
    }

    arm(() => finish({ status: 'unknown', reason: 'timeout' }), timeoutMs);

    const triggerRefresh = () => {
      io.requestCompile().then(
        (reply) => {
          if (settled) return;
          // A `{queued:true}` reply means ACCEPTED, not done — the completion
          // arrives separately as refresh_completed. Any other shape comes from
          // a package that still answers synchronously, and there the reply IS
          // the completion.
          // A pre-queue package answers only once the import has finished, so
          // its reply IS the completion. It reports no compile state, so the
          // quiet window (editor-awake gated) has to decide.
          if (!isQueuedAck(reply) && !importRan) noteImportRan(false);
        },
        () => {
          if (settled) return;
          // Rejection ≠ no compile (see the file header). Watch for activity;
          // only sustained silence decides anything.
          arm(() => {
            if (settled || activitySeen || importRan) return; // overall cap governs from here
            if (!io.getSnap().connected) {
              finish({ status: 'unknown', reason: 'bridge-lost' });
            } else if (retriesLeft > 0) {
              retriesLeft--;
              triggerRefresh();
            } else {
              finish({ status: 'unknown', reason: 'timeout' });
            }
          }, PROBE_MS);
        },
      );
    };

    triggerRefresh();
    // The editor may already be parked, in which case no store change is coming
    // to trigger the check — start the clock now.
    evaluateSleep(start);
  });
}

/** True for the `{queued:true}` ack a current bridge package returns. */
function isQueuedAck(reply: unknown): boolean {
  return (
    typeof reply === 'object' &&
    reply !== null &&
    (reply as { queued?: unknown }).queued === true
  );
}
