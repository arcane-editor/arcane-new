/**
 * Pure formatting helpers for the retry countdown `ErrorBlock` shows while a
 * `TurnError.retryAt` (epoch ms, `turn-errors.ts`) lockout is still active —
 * the account hourly cap, or a mid-stream provider 429 that carried a
 * `Retry-After`. No runtime imports, same Bun-testable discipline as
 * `turn-errors.ts`.
 */

/**
 * True when there is no lockout at all (`retryAt` undefined — most errors)
 * or the lockout has already elapsed. `now` is passed in rather than read
 * internally so the caller (a `setInterval` tick in `ErrorBlock`) controls
 * exactly when this re-evaluates, and so this stays pure/testable without
 * faking the clock.
 */
export function retryUnlocked(retryAt: number | undefined, now: number): boolean {
  return retryAt === undefined || now >= retryAt;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * Formats the time remaining until `retryAt` as `M:SS` (`"46:12"`, `"0:09"`),
 * or `H:MM:SS` once past an hour (`"1:02:05"`). Never negative — clamped to
 * 0 once `retryAt` has passed, and the remaining seconds are rounded UP
 * (`Math.ceil`) so the displayed countdown never shows `0:00` while the
 * lockout is technically still active for a sub-second longer.
 */
export function formatRetryCountdown(retryAt: number, now: number): string {
  const remainingMs = Math.max(0, retryAt - now);
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
  }
  return `${minutes}:${pad2(seconds)}`;
}
