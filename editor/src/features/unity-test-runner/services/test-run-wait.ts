// Wire the pure `waitForTestRun` state machine (test-run-wait-core.ts) to the
// unity + test stores and the bridge RPC — the test-runner equivalent of
// `unity-bridge/services/compile-wait.ts`. Mints the run's `runId`, issues the
// queued `runTests` RPC, and resolves once the run's REAL completion arrives
// (or an honest reason it never will).

import { useUnityStore } from '../../../stores/unity';
import { useTestStore, type TestMode } from '../stores/test-store';
import { bridgeRpc } from '../../unity-bridge';
import {
  waitForTestRun as waitForTestRunCore,
  type TestRunWaitIo,
  type TestRunWaitOutcome,
  type TestRunWaitSnap,
} from './test-run-wait-core';

export type { TestRunWaitOutcome } from './test-run-wait-core';
export { EDIT_MODE_TIMEOUT_MS, PLAY_MODE_TIMEOUT_MS } from './test-run-wait-core';

function snapOf(): TestRunWaitSnap {
  const unity = useUnityStore.getState();
  const test = useTestStore.getState();
  return {
    connected: unity.connected,
    bridgeState: unity.bridgeState,
    editorAwake: unity.editorAwake,
    editorCanWake: unity.editorCanWake,
    bridgeProtocol: unity.bridgeProtocol,
    lastRunCompleted: test.lastRunCompleted,
    run: test.run
      ? {
          active: test.run.active,
          mode: test.run.mode,
          runId: test.run.runId,
          total: test.run.total,
          passed: test.run.passed,
          failed: test.run.failed,
        }
      : null,
    results: test.results,
  };
}

function makeIo(mode: TestMode, filter: string | undefined, runId: string): TestRunWaitIo {
  return {
    getSnap: snapOf,
    subscribe: (cb) => {
      // Two independent stores feed one snapshot; either changing is a reason
      // to re-evaluate, so both are subscribed and both notify the same way.
      let prev = snapOf();
      const notify = () => {
        const next = snapOf();
        cb(next, prev);
        prev = next;
      };
      const u1 = useUnityStore.subscribe(notify);
      const u2 = useTestStore.subscribe(notify);
      return () => {
        u1();
        u2();
      };
    },
    requestRunTests: () => bridgeRpc.runTests(mode, filter, runId),
  };
}

/**
 * Run Unity tests and resolve with the run's outcome — a structured summary,
 * or an honest non-report outcome (`timeout`, `bridge-lost`, `editor-asleep`,
 * `not-installed`, `nothing-matched`, `aborted`). Never fakes success and
 * never hangs past the mode's default cap (`opts.timeoutMs` overrides it).
 */
export function waitForTestRun(
  mode: TestMode,
  filter: string | undefined,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<TestRunWaitOutcome> {
  const runId = crypto.randomUUID();
  return waitForTestRunCore(makeIo(mode, filter, runId), { runId, mode, ...opts });
}
