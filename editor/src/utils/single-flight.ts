/**
 * Wrap an async function so that at most one call is in flight at a time.
 *
 * Calling the wrapped function while a call is already running does not
 * start a second concurrent run. Instead it flags a trailing rerun and
 * returns the SAME in-flight promise — so a caller who awaits mid-flight is
 * guaranteed to resolve only after a run that started at (or after) their
 * own call, never a stale one. Any reruns that pile up while one is pending
 * collapse into a single extra run (a `while` loop, not a queue), so bursts
 * of calls never cause more than one additional invocation of `fn`.
 *
 * `fn` is invoked with the arguments from whichever call started the
 * in-flight run; a later call that only triggers a rerun does not change
 * those arguments (mirroring `git.ts`'s `refreshStatus`, whose sole argument
 * — the workspace path — never changes mid-session).
 *
 * On error, the in-flight state is cleared (via `finally`) and the
 * rejection propagates to every awaiter, so a later call always starts a
 * fresh run rather than reusing a rejected one.
 */
export function singleFlightWithRerun<Args extends unknown[]>(
  fn: (...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
  let inflight: Promise<void> | null = null;
  let rerun = false;

  return (...args: Args) => {
    if (inflight) {
      rerun = true;
      return inflight;
    }
    inflight = (async () => {
      do {
        rerun = false;
        await fn(...args);
      } while (rerun);
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };
}
