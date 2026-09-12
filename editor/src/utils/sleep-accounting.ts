// Sleep accounting — track how long Unity's main thread has been PARKED
// (`editorAwake: false`) and fire once a CUMULATIVE grace window has elapsed.
//
// Extracted out of `compile-wait-core.ts`, which pioneered this exact
// bookkeeping for the compile-wait state machine and needed it again,
// unchanged, for `test-run-wait-core.ts`. Both wait on a Unity-side operation
// whose only worthwhile answer, once the editor is provably not going to look
// at it any time soon, is an honest "editor-asleep" rather than the full
// overall timeout — and both need the SAME cumulative (not consecutive)
// accounting to say so correctly. See EDITOR_ASLEEP_GRACE_MS below for why
// cumulative is the part that matters.

/** Minimal timer seam so tests can drive a virtual clock. */
export interface SleepTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  /** Monotonic-enough clock. Needed to ACCUMULATE sleep across wake flickers. */
  now(): number;
}

/**
 * How much CUMULATIVE sleep a parked editor gets before a wait gives up on it.
 *
 * Cumulative, not consecutive, and that distinction is the whole point. A
 * backgrounded editor ticking slowly sits right on the package's awake
 * threshold, so successive heartbeats alternate awake/asleep. Re-arming a
 * consecutive-sleep countdown on every flicker means it never completes, and
 * the fast honest answer silently degrades back into whatever much longer cap
 * the caller has. Accumulating instead makes a half-parked editor resolve in
 * roughly twice the grace — which is the right answer, because an editor
 * asleep half the time is asleep as far as the wait is concerned.
 */
export const EDITOR_ASLEEP_GRACE_MS = 8_000;

export interface SleepTrackerOpts {
  timers: SleepTimers;
  /** Cumulative parked time before `onAsleep` fires. Defaults to EDITOR_ASLEEP_GRACE_MS. */
  graceMs?: number;
  /**
   * Called once the editor has been parked for the cumulative grace window.
   * The caller decides what "asleep" means for it (finish the wait, read
   * `editorCanWake` off a fresh snapshot, etc.) — this tracker only counts.
   */
  onAsleep: () => void;
}

export interface SleepTracker {
  /**
   * Feed the latest `editorAwake` reading. Call on every relevant store
   * snapshot, AND once up front with the starting snapshot — a parked editor
   * at the start has no store change coming to kick off the clock.
   */
  update(awake: boolean): void;
  /** Stop counting. Call once settled, or once real activity makes sleep moot. */
  clear(): void;
}

export function createSleepTracker(opts: SleepTrackerOpts): SleepTracker {
  const { timers, onAsleep } = opts;
  const graceMs = opts.graceMs ?? EDITOR_ASLEEP_GRACE_MS;

  /** Sleep already banked from earlier parked stretches. */
  let sleepAccumMs = 0;
  /** Clock reading when the current parked stretch began, or null while awake. */
  let asleepSince: number | null = null;
  let handle: unknown = null;

  const clear = () => {
    if (handle === null) return;
    timers.clear(handle);
    handle = null;
  };

  const update = (awake: boolean) => {
    const nowMs = timers.now();

    if (awake) {
      // Bank the stretch that just ended; do NOT reset the total, or a
      // flickering editor would restart the countdown forever.
      if (asleepSince !== null) {
        sleepAccumMs += nowMs - asleepSince;
        asleepSince = null;
      }
      clear();
      return;
    }

    if (asleepSince === null) asleepSince = nowMs;
    if (handle !== null) return; // already counting down
    const elapsed = sleepAccumMs + (nowMs - asleepSince);
    const remaining = Math.max(0, graceMs - elapsed);
    handle = timers.set(() => {
      handle = null;
      onAsleep();
    }, remaining);
  };

  return { update, clear };
}
