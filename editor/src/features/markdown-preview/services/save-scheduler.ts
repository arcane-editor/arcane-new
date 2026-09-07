/**
 * Debounced disk writes with a flush you can await.
 *
 * Typing in the plan document used to be a series of discrete commits — one
 * blur, one full `write_file` IPC round trip, one git-status refresh. Editing
 * in place means a change per keystroke, so the write has to be debounced or
 * every character costs a disk write and a git scan.
 *
 * `flush()` is the part that matters as much as the debounce. Execution reads
 * the plan back from DISK and refuses to start while the tab is dirty
 * (`plan-run.ts`'s dirty-tab guard), so anything that starts a run — Execute,
 * Resume — must be able to force the pending write out and WAIT for it. The
 * same goes for unmount: a plan tab closed mid-sentence has to take the
 * sentence with it.
 *
 * Writes never overlap: a scheduled write that fires while another is still in
 * flight waits its turn, so two saves can't interleave onto the same file.
 *
 * Pure and timer-driven, so it tests without a DOM like every other service
 * here (`save-scheduler.test.ts`).
 */

export interface SaveScheduler {
  /** Note that there is something to write; restarts the idle timer. */
  schedule(): void;
  /** Write now (if anything is pending) and resolve once the write is done. */
  flush(): Promise<void>;
  /** Drop a pending write without performing it. */
  cancel(): void;
}

export interface SaveSchedulerOptions {
  /** Performs the actual write. Rejections are swallowed — see `run`. */
  save: () => Promise<void>;
  /** Idle time before a scheduled write goes out. */
  delayMs: number;
}

export function createSaveScheduler({ save, delayMs }: SaveSchedulerOptions): SaveScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let inFlight: Promise<void> | null = null;

  function clear(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  async function run(): Promise<void> {
    // Wait out a write already going to the same file rather than racing it.
    while (inFlight) await inFlight;
    if (!pending) return;
    pending = false;
    const attempt = save().catch(() => {
      // A failed write must not wedge the scheduler: the store still holds the
      // text, the tab stays dirty, and the next keystroke schedules another
      // attempt. Surfacing the error is `saveFile`'s job, not this timer's.
    });
    inFlight = attempt;
    try {
      await attempt;
    } finally {
      if (inFlight === attempt) inFlight = null;
    }
  }

  return {
    schedule() {
      pending = true;
      clear();
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, delayMs);
    },
    async flush() {
      clear();
      await run();
    },
    cancel() {
      clear();
      pending = false;
    },
  };
}
