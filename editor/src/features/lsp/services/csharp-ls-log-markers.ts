/**
 * The csharp-ls log lines the editor's behaviour depends on.
 *
 * csharp-ls reports solution-load progress through `window/logMessage`, not
 * `$/progress`, so these strings are load-bearing protocol: the readiness gate
 * (`project-readiness.ts`) holds diagnostics until a load finishes, and the
 * status bar keys off the same lines. They live here, pure and tested, so both
 * the app and `verify:intellisense` recognise a load the same way — a probe
 * with its own copy of the regex would keep passing through a rename that had
 * degraded the app to its failsafe timer.
 *
 * Verified against csharp-ls 0.27.0 (`Roslyn/Solution.fs`), which emits:
 *
 *     Loading solution "…"...
 *     Finished loading solution "…"
 *     loading project "…"..
 *
 * Messages arrive with a `csharp-ls: ` prefix over `window/logMessage` and
 * without it on stderr, so both spellings are accepted.
 */

function strip(message: string): string {
  return message.replace(/^csharp-ls:\s*/i, '').trim();
}

/**
 * A solution or project load has STARTED.
 *
 * This matters more than it looks. csharp-ls 0.23 made solution loading
 * on-demand: nothing is loaded at `initialize`, and the load begins with the
 * first `didOpen`. So "the project graph is ready" is not a one-time event
 * that happens at startup any more — it can go back to being false, minutes
 * into a session, the first time a C# file is opened. A gate that only ever
 * opens would answer diagnostics out of an empty workspace in that window,
 * which is a CS0518 cascade over every line of the file.
 */
export function isLoadStartedMessage(message: string): boolean {
  return /^loading (solution|project)\b/i.test(strip(message));
}

/** A solution or project load has FINISHED and the graph is usable. */
export function isLoadFinishedMessage(message: string): boolean {
  return /^finished loading (solution|project)\b/i.test(strip(message));
}
