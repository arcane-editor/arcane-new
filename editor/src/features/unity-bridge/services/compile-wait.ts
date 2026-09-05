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
//  - Trigger DIRECTLY over the bridge, not through the approval-gated
//    `unity_refresh` tool, so the gate never prompts the user.
//  - Always hard-timeout (and honor the abort signal) so a never-finishing
//    compile can't hang the agent turn.
//
// What changed, and why. Two rounds of the same lesson:
//
//  1. A rejection is not a failed compile. The RPC predictably rejects at the
//     exact moment a compile starts, and resolving that as silent success made
//     the agent stop right as Unity started working.
//
//  2. An ACK is not a finished import. `requestCompile` is queued on the Unity
//     side, because Unity parks its main thread whenever its window is
//     unfocused — the normal state while the user is in this IDE. Blocking on
//     that thread never made the work happen; it just failed after eight
//     seconds, and every failed ask stayed queued to fire in a burst when the
//     user eventually clicked Unity. The queued command acks immediately and
//     reports its real completion as `unity-refresh-completed`, which is the
//     signal the core waits on.

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
    editorAwake: s.editorAwake,
    editorCanWake: s.editorCanWake,
    refreshCompletedAt: s.refreshCompletedAt,
    refreshCompiling: s.refreshCompiling,
  };
}

/**
 * `requestCompile` with a fall-back to `refreshAssets` for a Unity package that
 * predates it. An older package answers MethodNotFound, which is a stale
 * install — not a bridge failure — and must not be reported to the model as one.
 */
async function requestCompile(): Promise<unknown> {
  try {
    return await bridgeRpc.requestCompile();
  } catch (err) {
    if (!isUnknownMethod(err)) throw err;
    return bridgeRpc.refreshAssets();
  }
}

function isUnknownMethod(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err ?? '');
  return /unknown method/i.test(text);
}

const storeIo: CompileWaitIo = {
  getSnap: () => snapOf(useUnityStore.getState()),
  subscribe: (cb) =>
    useUnityStore.subscribe((state, prev) => cb(snapOf(state), snapOf(prev))),
  requestCompile,
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
