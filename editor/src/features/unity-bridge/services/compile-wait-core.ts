// Pure compile-wait state machine — the store/RPC-free half of
// `triggerRecompileAndWait` (see compile-wait.ts for the wiring and for why
// this exists at all). Extracted behind the `CompileWaitIo` seam so the state
// machine is directly Bun-testable, mirroring the `HintLookup` /
// `DiagnosticsFetcher` DI pattern used by the ai-panel gates.
//
// The one rule this file exists to enforce: a `refreshAssets` rejection is NOT
// "the compile didn't happen". The RPC predictably fails at the exact moment a
// compile starts — the C# handler caps at 8s while AssetDatabase.Refresh()
// imports, the dispatcher cancels all waits on beforeAssemblyReload, and the
// Rust side drains pending RPCs on the reload flap — so the old
// resolve-null-on-reject behavior returned fake success precisely when Unity
// was busy doing exactly what we asked. A rejection keeps the wait alive; only
// sustained silence while disconnected, the overall cap, or an abort ends it.

import type { CompilationPayload } from '../../../types/unity';

/** What a compile wait resolved to. Every branch is honest — no fake success. */
export type CompileWaitOutcome =
  | { status: 'report'; report: CompilationPayload }
  /** Refresh completed and Unity never started compiling — nothing to build. */
  | { status: 'no-compile' }
  | { status: 'unknown'; reason: 'timeout' | 'bridge-lost' | 'aborted' };

/** The slice of unity-store state the machine observes. */
export interface UnitySnap {
  connected: boolean;
  bridgeState: string;
  isCompiling: boolean;
  lastCompilation: CompilationPayload | null;
}

export interface CompileWaitIo {
  getSnap(): UnitySnap;
  /** Zustand-style: cb(next, prev) on every store change. Returns unsubscribe. */
  subscribe(cb: (snap: UnitySnap, prev: UnitySnap) => void): () => void;
  refreshAssets(): Promise<unknown>;
}

/** Injectable timers so tests drive the clock (defaults to real setTimeout). */
export interface CompileWaitTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: CompileWaitTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Hard ceiling on the whole wait. Matches the Rust bridge's reload-widened
 * peer-dead window (`unity_ipc.rs` widens 8s → 90s while `reloading`): a big
 * project's import + compile + domain reload legitimately takes this long.
 */
export const OVERALL_TIMEOUT_MS = 90_000;
/** After a SUCCESSFUL refresh with zero compile activity: nothing to build. */
export const NO_COMPILE_QUIET_MS = 5_000;
/** After a REJECTED refresh: how long to watch for activity before acting. */
export const PROBE_MS = 12_000;
/** Refresh retries after a rejection while still connected (the ask may have been swallowed by a reload flap). */
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
    let retriesLeft = MAX_REFRESH_RETRIES;
    const handles: unknown[] = [];
    let unsub: (() => void) | null = null;
    let onAbort: (() => void) | null = null;

    const baseline = io.getSnap().lastCompilation;

    const finish = (outcome: CompileWaitOutcome) => {
      if (settled) return;
      settled = true;
      for (const h of handles) timers.clear(h);
      unsub?.();
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };

    const arm = (fn: () => void, ms: number) => {
      handles.push(timers.set(fn, ms));
    };

    // Listen FIRST, so a fast compile can't finish before we're watching.
    // Resolve only on a fresh `lastCompilation` object identity (the store
    // assigns a new object only on a finished payload — see stores/unity.ts).
    unsub = io.subscribe((snap) => {
      if (snap.isCompiling || snap.bridgeState === 'reloading') activitySeen = true;
      if (snap.lastCompilation && snap.lastCompilation !== baseline) {
        activitySeen = true;
        finish({ status: 'report', report: snap.lastCompilation });
      }
    });

    if (signal) {
      onAbort = () => finish({ status: 'unknown', reason: 'aborted' });
      signal.addEventListener('abort', onAbort, { once: true });
    }

    arm(() => finish({ status: 'unknown', reason: 'timeout' }), timeoutMs);

    const triggerRefresh = () => {
      io.refreshAssets().then(
        () => {
          if (settled) return;
          // Refresh completed. If nothing starts compiling shortly, there was
          // nothing to build (e.g. the write left the file byte-identical).
          arm(() => {
            if (!activitySeen) finish({ status: 'no-compile' });
          }, NO_COMPILE_QUIET_MS);
        },
        () => {
          if (settled) return;
          // Rejection ≠ no compile (see the file header). Watch for activity;
          // only sustained silence decides anything.
          arm(() => {
            if (settled || activitySeen) return; // overall cap governs from here
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
  });
}
