/**
 * Shared, pure stream-hardening primitives used by both the production
 * `hosted-stream.ts` StreamFn and the eval harness's `eval-stream.ts`
 * StreamFn (tooling/unity-eval). Extracted so the two don't drift: the
 * eval's retry/timeout behavior was hardened against real Cloudflare
 * Workers AI failures (rate-limit 3021, 502/1031 gateway errors, and a
 * documented ~53-minute hang with no response), and production needs the
 * exact same classification + backoff + signal-composition semantics.
 *
 * This module has no dependency on fetch/Response/DOM specifics beyond the
 * standard Web APIs (AbortController/AbortSignal) so it's safe to import
 * from both a browser-embedded (Tauri) context and a headless Bun script.
 */

// =========================================================================
// Transient-failure classification
// =========================================================================

/**
 * Classifies an HTTP status code as transient (worth retrying with backoff)
 * vs terminal (retrying would just waste an attempt on a guaranteed repeat
 * failure).
 *
 * - 429 (rate limited) and 5xx (server/gateway errors) are transient — this
 *   is the eval's original classification, observed for real against CF
 *   Workers AI (rate-limit 3021, 502/1031).
 * - 408 (Request Timeout) is also treated as transient: it signals the
 *   server gave up waiting on the request rather than rejecting it as
 *   malformed or unauthorized, the same "retry is safe" shape as 429/5xx.
 * - All other 4xx (400 bad request, 401/403 auth, 404 not found, ...) are
 *   never transient: the request itself is the problem, so retrying it
 *   unchanged will only reproduce the same failure.
 */
export function isTransient(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

// =========================================================================
// Backoff
// =========================================================================

/**
 * Linear backoff schedule: `baseDelayMs * attempt` (attempt is 1-indexed,
 * so the first retry waits `baseDelayMs`, the second `2 * baseDelayMs`,
 * etc.). Matches the eval's original schedule (e.g. 20s/40s at its
 * default); production uses a shorter base since a user is waiting live.
 */
export function computeBackoffMs(attempt: number, baseDelayMs: number): number {
  return baseDelayMs * attempt;
}

// =========================================================================
// Signal composition
// =========================================================================

/**
 * Combines zero or more (possibly undefined) AbortSignals into a single
 * signal that aborts as soon as any input does. Filters out `undefined`
 * entries so callers don't need to special-case an absent caller signal.
 * Returns a signal that never aborts when no signals are provided.
 */
export function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
  const defined = signals.filter((s): s is AbortSignal => s !== undefined);
  if (defined.length === 0) return new AbortController().signal;
  if (defined.length === 1) return defined[0];
  return AbortSignal.any(defined);
}

function toAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}

// =========================================================================
// Abortable sleep (backoff waits)
// =========================================================================

/**
 * Resolves after `ms`, or rejects immediately with an AbortError if
 * `signal` is already aborted or aborts before the delay elapses. Used for
 * retry backoff waits so a caller cancellation during a retry delay
 * surfaces immediately instead of only being discovered on the next
 * attempt (or after waiting out the full backoff).
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(toAbortError(signal.reason));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(toAbortError(signal?.reason));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// =========================================================================
// Idle / read-gap watchdog
// =========================================================================

/** Marker error distinguishing a `raceWithTimeout` timeout from any other failure. */
export class TimeoutRaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutRaceError';
  }
}

/**
 * Races `promise` against a timeout. If `promise` settles first, its
 * resolution/rejection is forwarded as-is. If the timeout elapses first,
 * `onTimeout` is invoked (fire-and-forget — e.g. to cancel an underlying
 * stream reader) and the race rejects with a `TimeoutRaceError`.
 *
 * Used for the idle-gap watchdog: each `reader.read()` call is raced
 * individually, so the "gap" being guarded is naturally the time between
 * chunks (or between stream start and the first chunk) — no persistent
 * timer bookkeeping/reset logic is needed.
 */
export function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout?.();
      reject(new TimeoutRaceError(timeoutMessage));
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
