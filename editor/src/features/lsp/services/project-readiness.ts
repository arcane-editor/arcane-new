// C# project-graph readiness gate.
//
// **The bug this exists to prevent.** csharp-ls answers
// `textDocument/diagnostic` from the moment it is initialized — including the
// seconds while MSBuild is still expanding `.unityide.csproj` and Roslyn has not
// yet attached its metadata references. An answer computed in that window is
// not "no errors yet"; it is a full, confident diagnostic report against a
// compilation that has no corelib, so *every* predefined type fails to bind:
//
//     CS0518: Predefined type 'System.Void' is not defined or imported
//
// on essentially every line of the file. The same report is what a file that
// belongs to no project at all produces — see `scheduleUnityCsprojReload` in
// `stores/workspace.ts`, which documents the sibling case (a script created
// after MSBuild expanded the `Assets/**/*.cs` glob).
//
// Nothing about that report is distinguishable from a real one at the wire
// level, and it used to stick for the entire session: the only pull triggers
// were a blind 300ms timer on model creation and `onDidChangeContent`, so a
// user who opened a file and did not type never got a corrected report. Worse,
// the bogus report's `resultId` was cached, so the next pull answered
// `kind: "unchanged"` and the markers were never repainted — surviving even a
// close/reopen of the tab, because Monaco keys markers by resource URI rather
// than by model instance. Only restarting the app cleared it.
//
// So: hold diagnostics until the server says the project graph is loaded, then
// re-pull everything. The signal is csharp-ls's `window/logMessage` stream
// ("Finished loading solution"/"Finished loading project"), parsed in
// `stores/workspace.ts` — the same marker that already drives the status bar.
//
// **The gate always opens.** A gate that can wedge shut would trade wrong
// diagnostics for no diagnostics, which is worse — it fails silently. So
// `resetCsharpProjectLoaded` arms a failsafe that opens the gate regardless,
// making a future csharp-ls that renames or drops that log line degrade back
// to today's behaviour rather than to permanent silence.

/** Notified once each time the gate opens. */
export type ProjectLoadedListener = () => void;

/**
 * Failsafe window. csharp-ls reports the load-finished marker about a second
 * after `initialized` on a warm MSBuild, and single-digit seconds cold; this
 * is deliberately far above both so it only ever fires when the marker itself
 * never arrives.
 */
export const CSHARP_READINESS_FAILSAFE_MS = 20_000;

let loaded = false;
let failsafeTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<ProjectLoadedListener>();

function clearFailsafe(): void {
  if (failsafeTimer) {
    clearTimeout(failsafeTimer);
    failsafeTimer = null;
  }
}

/**
 * True once csharp-ls has a usable project graph — i.e. a diagnostic report it
 * returns now reflects the real reference set. Callers that produce diagnostics
 * must check this; callers that consume position-based features (hover,
 * completion, definition) need not, since a null answer from those degrades
 * gracefully on its own.
 */
export function isCsharpProjectLoaded(): boolean {
  return loaded;
}

/**
 * A load has STARTED — close the gate and re-arm the failsafe.
 *
 * csharp-ls 0.23 made solution loading on-demand: nothing loads at
 * `initialize`, and the load begins with the first `didOpen`. Readiness is
 * therefore no longer a one-time startup event. Without this, a session that
 * sits for 20s before its first C# file is opened has already had the failsafe
 * open the gate, so the pull scheduled 300ms after that file appears is
 * answered out of an empty workspace — a CS0518 cascade over every line, whose
 * `resultId` is then cached and repeated as `unchanged`. That is the exact
 * failure this module was written to prevent, reintroduced by a server
 * upgrade rather than by a diff.
 *
 * Idempotent per load: csharp-ls logs one line per project, and re-closing an
 * already-closed gate is a no-op.
 */
export function markCsharpProjectLoading(
  failsafeMs: number = CSHARP_READINESS_FAILSAFE_MS,
): void {
  // Re-arm the failsafe from the START OF THIS LOAD, whether or not the gate
  // was already closed.
  //
  // The window it closes: the app arms a 20s failsafe when the server starts,
  // the user spends 18s reading something that is not C#, and only then opens
  // their first `.cs` file. With on-demand loading that is when the solution
  // load begins — and an early-return here would leave the original timer to
  // fire two seconds later, mid-load. The 300ms pull that follows is answered
  // from an empty workspace, its CS0518 cascade is cached under a resultId,
  // and the real "Finished loading" marker then hits `markCsharpProjectLoaded`'s
  // `if (loaded) return` and notifies nobody. No corrective re-pull, wrong
  // diagnostics until restart — exactly what this module exists to prevent.
  loaded = false;
  clearFailsafe();
  failsafeTimer = setTimeout(() => {
    failsafeTimer = null;
    markCsharpProjectLoaded();
  }, failsafeMs);
}

/**
 * Open the gate and notify listeners. Idempotent: repeated load-finished
 * markers (csharp-ls logs one per project) notify only on the first.
 */
export function markCsharpProjectLoaded(): void {
  clearFailsafe();
  if (loaded) return;
  loaded = true;

  // Snapshot: a listener may unsubscribe itself (see `whenCsharpProjectLoaded`).
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.warn('[LSP] csharp project-loaded listener threw:', err);
    }
  }
}

/**
 * Close the gate for a fresh csharp-ls. Call *before* `client.start()` so a
 * pull scheduled by a model created during startup is held rather than
 * answered from an unloaded workspace.
 *
 * Covers restarts as well as first start: crash recovery and the Unity csproj
 * hot-reload both funnel through `attemptLspStartFor`, and both genuinely
 * invalidate the project graph.
 *
 * `failsafeMs` is overridable so tests need not wait out the real window.
 */
export function resetCsharpProjectLoaded(
  failsafeMs: number = CSHARP_READINESS_FAILSAFE_MS,
): void {
  loaded = false;
  clearFailsafe();
  failsafeTimer = setTimeout(() => {
    failsafeTimer = null;
    console.warn(
      `[LSP] csharp-ls reported no load-finished marker within ${failsafeMs}ms — ` +
        'releasing the diagnostics gate anyway',
    );
    markCsharpProjectLoaded();
  }, failsafeMs);
}

/**
 * Subscribe to gate openings. Fires on every open (once per server lifetime),
 * not just the first, so a restart re-triggers the re-pull. Returns an
 * unsubscribe.
 *
 * Does **not** fire immediately if the gate is already open — use
 * `isCsharpProjectLoaded` for that check, or `whenCsharpProjectLoaded` to await.
 */
export function onCsharpProjectLoaded(listener: ProjectLoadedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Resolves as soon as the gate is (or becomes) open. */
export function whenCsharpProjectLoaded(): Promise<void> {
  if (loaded) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = onCsharpProjectLoaded(() => {
      unsubscribe();
      resolve();
    });
  });
}
