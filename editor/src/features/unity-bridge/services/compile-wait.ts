// Trigger a Unity recompile via the bridge and await the resulting compile
// report. This is the engine-grounded half of the AI compile gate: after the
// agent writes a .cs file, we ask Unity to refresh + recompile, then resolve
// with a structured outcome so the gate can feed real compiler errors back to
// the model — or say HONESTLY that it couldn't verify.
//
// The state machine itself lives in compile-wait-core.ts (pure, Bun-tested);
// this file only wires it to the unity store and the bridge RPC. Key
// correctness points preserved from the original implementation:
//  - Subscribe to the store BEFORE triggering the refresh, so a fast compile
//    can't finish before we're listening (the core enforces the ordering).
//  - Resolve only on a *fresh* `lastCompilation` object identity, which makes
//    the wait survive the domain-reload disconnect/reconnect flap.
//  - Trigger with `bridgeRpc.refreshAssets()` DIRECTLY, not the approval-gated
//    `unity_refresh` tool, so the gate never prompts the user.
//  - Always hard-timeout (and honor the abort signal) so a never-finishing
//    compile can't hang the agent turn.
//
// What changed (agent-reliability fix): a `refreshAssets` rejection no longer
// resolves as silent success. The RPC predictably rejects at the exact moment
// a compile starts (C# 8s handler cap during import, dispatcher cancel on
// beforeAssemblyReload, Rust draining pending RPCs on the reload flap), and
// the old `.catch(() => finish(null))` made the agent stop right as Unity
// started compiling — with no error and no retry. See compile-wait-core.ts.

import { useUnityStore } from '../../../stores/unity';
import { bridgeRpc } from './bridge-rpc';
import {
  waitForCompileReport,
  type CompileWaitIo,
  type CompileWaitOutcome,
  type UnitySnap,
} from './compile-wait-core';

export type { CompileWaitOutcome } from './compile-wait-core';

function snapOf(s: ReturnType<typeof useUnityStore.getState>): UnitySnap {
  return {
    connected: s.connected,
    bridgeState: s.bridgeState,
    isCompiling: s.isCompiling,
    lastCompilation: s.lastCompilation,
  };
}

const storeIo: CompileWaitIo = {
  getSnap: () => snapOf(useUnityStore.getState()),
  subscribe: (cb) =>
    useUnityStore.subscribe((state, prev) => cb(snapOf(state), snapOf(prev))),
  refreshAssets: () => bridgeRpc.refreshAssets(),
};

/**
 * Ask Unity to recompile and resolve with the next finished compile report,
 * or an honest non-report outcome (`no-compile`, `unknown`). Never fakes
 * success and never hangs past the overall cap.
 */
export function triggerRecompileAndWait(
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CompileWaitOutcome> {
  return waitForCompileReport(storeIo, opts);
}
