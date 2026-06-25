// Trigger a Unity recompile via the bridge and await the resulting compile
// report. This is the engine-grounded half of the AI compile gate: after the
// agent writes a .cs file, we ask Unity to refresh + recompile, then resolve
// with the structured `lastCompilation` report so the gate can feed real
// compiler errors back to the model.
//
// Key correctness points:
//  - Subscribe to the store BEFORE triggering the refresh, so a fast compile
//    can't finish before we're listening.
//  - Resolve only on a *fresh* `lastCompilation` object identity (the store
//    assigns a new object only on the finished payload — see stores/unity.ts),
//    which makes us survive the domain-reload disconnect/reconnect flap.
//  - Trigger with `bridgeRpc.refreshAssets()` DIRECTLY, not the approval-gated
//    `unity_refresh` tool, so the gate never prompts the user.
//  - Always hard-timeout (and honor the abort signal) so a never-finishing
//    compile can't hang the agent turn.

import { useUnityStore } from '../../../stores/unity';
import { bridgeRpc } from './bridge-rpc';
import type { CompilationPayload } from '../../../types/unity';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Ask Unity to recompile and resolve with the next finished compile report.
 * Resolves `null` on timeout, abort, or if the bridge drops before reporting —
 * callers treat null as "couldn't verify, degrade gracefully".
 */
export function triggerRecompileAndWait(
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CompilationPayload | null> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = opts;

  if (signal?.aborted) return Promise.resolve(null);

  return new Promise<CompilationPayload | null>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsub: (() => void) | null = null;
    let onAbort: (() => void) | null = null;

    const finish = (report: CompilationPayload | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsub?.();
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      resolve(report);
    };

    // Listen first — resolve on the next finished report (new object identity).
    unsub = useUnityStore.subscribe((state, prev) => {
      if (state.lastCompilation && state.lastCompilation !== prev.lastCompilation) {
        finish(state.lastCompilation);
      }
    });

    if (signal) {
      onAbort = () => finish(null);
      signal.addEventListener('abort', onAbort, { once: true });
    }

    timer = setTimeout(() => finish(null), timeoutMs);

    // Trigger the recompile AFTER the subscription is live. A rejection means
    // the bridge dropped between the connected-check and here — resolve null
    // promptly rather than waiting out the full timeout.
    bridgeRpc.refreshAssets().catch(() => finish(null));
  });
}
