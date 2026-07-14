/**
 * update-coalescer — trailing-edge coalescer for high-frequency streamed
 * updates (R2-T4, Stage 1 chat perf). Wired into `stores/ai.ts`'s
 * `message_update` handling so a burst of token deltas produces at most one
 * store write per `windowMs`, instead of one `messages` array replacement
 * (and downstream re-render + markdown re-parse) per token.
 *
 * Semantics:
 *  - If no flush is currently pending AND the last `apply` happened at least
 *    `windowMs` ago (or never happened), `push` applies immediately.
 *  - Otherwise the pushed item is stashed (overwriting any previously
 *    stashed item — only the LATEST survives) and, if no trailing flush is
 *    already scheduled, one is scheduled for the remainder of the window.
 *  - `cancel()` drops any pending trailing flush and its stashed item
 *    without applying it. Safe to call when nothing is pending.
 *
 * `schedule`/`cancel`/`now` are injectable so tests can drive the coalescer
 * with a fake clock instead of real timers (see `update-coalescer.test.ts`).
 * They default to `setTimeout`/`clearTimeout`/`Date.now`.
 *
 * This module is intentionally ignorant of *why* a flush might need to be a
 * no-op (e.g. the stream already ended/was truncated/aborted by the time a
 * trailing flush fires) — that's the caller's `apply` callback's job to
 * re-check against live state before mutating anything. See `stores/ai.ts`'s
 * `message_update` case, which re-reads `get().streamingMessageId` inside
 * its `apply`.
 */

export interface UpdateCoalescerOptions<T> {
  /** Minimum time between applies; default 40ms (~25Hz). */
  windowMs?: number;
  /** Schedules `cb` to run after `delayMs`. Returns an opaque handle for `cancel`. */
  schedule?: (cb: () => void, delayMs: number) => unknown;
  /** Cancels a handle previously returned by `schedule`. */
  cancel?: (handle: unknown) => void;
  /** Returns the current time in milliseconds. */
  now?: () => number;
  /** Invoked with the item to apply — either immediately or on trailing flush. */
  apply: (item: T) => void;
}

export interface UpdateCoalescer<T> {
  /** Push a new item; applies immediately or coalesces per the class doc. */
  push(item: T): void;
  /** Drops any pending trailing flush (and its stashed item) without applying it. */
  cancel(): void;
}

const defaultSchedule = (cb: () => void, delayMs: number): unknown => setTimeout(cb, delayMs);
const defaultCancel = (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>);
const defaultNow = (): number => Date.now();

export function createUpdateCoalescer<T>(options: UpdateCoalescerOptions<T>): UpdateCoalescer<T> {
  const windowMs = options.windowMs ?? 40;
  const schedule = options.schedule ?? defaultSchedule;
  const cancelScheduled = options.cancel ?? defaultCancel;
  const now = options.now ?? defaultNow;
  const apply = options.apply;

  let lastApplyAt = -Infinity;
  let pendingHandle: unknown = null;
  let pendingItem: T | undefined;

  function flush(): void {
    pendingHandle = null;
    const item = pendingItem as T;
    pendingItem = undefined;
    lastApplyAt = now();
    apply(item);
  }

  function push(item: T): void {
    const t = now();
    if (pendingHandle === null && t - lastApplyAt >= windowMs) {
      lastApplyAt = t;
      apply(item);
      return;
    }
    pendingItem = item;
    if (pendingHandle === null) {
      const delay = Math.max(0, windowMs - (t - lastApplyAt));
      pendingHandle = schedule(flush, delay);
    }
  }

  function cancel(): void {
    if (pendingHandle !== null) {
      cancelScheduled(pendingHandle);
      pendingHandle = null;
      pendingItem = undefined;
    }
  }

  return { push, cancel };
}
