// The post-turn console check's store/RPC boundary (Task 13).
//
// `console-check.ts` is pure and Bun-testable (Global Constraint 4): it never
// imports a store, the bridge, or Tauri. This file is the other half — the only
// place the check reads `stores/unity.ts`, calls `bridgeRpc`, or touches the
// filesystem. It deliberately does no deciding: it reads facts and hands them
// to the pure core.
//
// Not Bun-importable itself (it reaches `stores/unity.ts`), so it carries no
// tests of its own; every decision it feeds is covered in
// `console-check.test.ts`, and the wiring is pinned by source assertions in
// `agent-service-wiring.test.ts`.

import { invoke } from '@tauri-apps/api/core';
import { bridgeRpc } from '../../unity-bridge';
import { useUnityStore } from '../../../stores/unity';
import { useWorkspaceStore } from '../../../stores/workspace';
import type { UnityLogEntry } from '../../../types/unity';
import type { RegionDeps } from './prompts/console-repair';
import type { VerifiedCardData } from './verified-pass';
import {
  CONSOLE_ERROR_TYPES,
  CONSOLE_MIN_PROTOCOL,
  CONSOLE_SNAPSHOT_LIMIT,
  collectNewProblems,
  type CollectedProblems,
  type CompileProblem,
  type ConsoleCheckBaseline,
  type ConsoleEntryInput,
  type SnapshotStatus,
} from './console-check';

/**
 * The production region reader for `prompts/console-repair.ts`: Tauri file
 * reads, rooted at the open workspace. Shared by the one-click "Fix this
 * console error" flow and the console check's repair pass so both embed code
 * the same way.
 */
export function tauriRegionDeps(): RegionDeps {
  return {
    readFile: (path) => invoke<string>('read_file', { path }),
    workspacePath: useWorkspaceStore.getState().workspacePath,
  };
}

/** The console baseline for the send about to start. */
export function consoleBaselineNow(): ConsoleCheckBaseline {
  const unity = useUnityStore.getState();
  return {
    seq: unity.logSeq,
    epoch: unity.consoleEpoch,
    startedAt: Date.now(),
    compileIdentity: unity.lastCompilation?.receivedAt ?? null,
    editorAwake: unity.editorAwake,
    maxUnityRow: maxUnityRow(unity.logs),
  };
}

/**
 * The furthest Unity's own console had got by send start, or `null` when
 * nothing in the ring came from Unity's history. It is the only thing that can
 * date a `getConsoleSnapshot` row, and with no value there is nothing to
 * compare against — so the check adopts no snapshot-only rows at all.
 */
function maxUnityRow(logs: UnityLogEntry[]): number | null {
  let max: number | null = null;
  for (const e of logs) {
    if (e.unityRow == null) continue;
    if (max === null || e.unityRow > max) max = e.unityRow;
  }
  return max;
}

/** The newest test run in a batch of recorded ones, or `null`. */
export function latestRun<T>(runs: T[]): T | null {
  return runs.length > 0 ? runs[runs.length - 1] : null;
}

/**
 * Compiler errors that describe THIS turn.
 *
 * Two independent conditions, and both are needed. The verified pass's own
 * `compile` step is the authority on whether the fresh compile reported errors
 * at all (it is the one that triggered it); `lastCompilation` is the only place
 * the per-file diagnostics live, and it survives across sends — so a report
 * whose `receivedAt` has not moved since the baseline is the PREVIOUS turn's
 * and must never be handed to a repair pass.
 */
function freshCompileErrors(
  pass: VerifiedCardData,
  compileIdentity: number | null,
): CompileProblem[] {
  if (pass.compile === 'clean' || pass.compile === 'skipped') return [];
  const last = useUnityStore.getState().lastCompilation;
  const receivedAt = last?.receivedAt ?? null;
  if (receivedAt == null) return [];
  if (compileIdentity != null && receivedAt <= compileIdentity) return [];
  return (last?.messages ?? [])
    .filter((m) => m.type === 'Error')
    .map((m) => ({ file: m.file, line: m.line, message: m.message }));
}

function ringEntry(e: UnityLogEntry): ConsoleEntryInput {
  return {
    logType: e.logType,
    message: e.message,
    seq: e.seq ?? null,
    stackTrace: e.stackTrace,
    parsedFrames: e.parsedFrames,
    historical: e.historical,
    unityRow: e.unityRow ?? null,
  };
}

/**
 * Read the console the way the check needs it: the session ring always, plus
 * one `getConsoleSnapshot` when the bridge can answer it.
 *
 * The snapshot RPC blocks on Unity's main thread and therefore FAILS outright
 * whenever Unity is parked in the background — the normal state while the user
 * is looking at this IDE. That is "snapshot unavailable", never an error of the
 * check, so the ring result stands on its own.
 */
export async function collectConsoleProblems(
  baseline: ConsoleCheckBaseline,
  pass: VerifiedCardData,
  run: { failures?: Array<{ fullName: string; message: string }> } | null,
): Promise<CollectedProblems> {
  const unity = useUnityStore.getState();

  let snapshot: ConsoleEntryInput[] | null = null;
  let snapshotStatus: SnapshotStatus = 'not-attempted';
  if (unity.connected && (unity.bridgeProtocol ?? 0) >= CONSOLE_MIN_PROTOCOL) {
    try {
      const snap = await bridgeRpc.getConsoleSnapshot({
        order: 'newest',
        limit: CONSOLE_SNAPSHOT_LIMIT,
        types: [...CONSOLE_ERROR_TYPES],
        includeStackTrace: true,
      });
      snapshot = snap.entries.map((row) => ({
        logType: row.logType,
        message: row.message,
        // A snapshot row's wire `seq` is Unity's CONSOLE ROW INDEX, a different
        // and incomparable numbering (see `UnityLogEntry.unityRow`). It goes in
        // `unityRow`, where the adoption rule can date it, and never in `seq`.
        //
        // ONLY for a `source:'logEntries'` answer, though. The reflection
        // fallback (`source:'hookRing'`) answers from the bridge's own ring,
        // whose `seq` is a per-session ring counter — not a row index — and
        // comparing it against the send-start high-water mark adopted
        // hours-old errors as "new this turn" after a console clear. Mirrors
        // `stores/unity.ts`'s `backfillConsoleHistory`, which drops it for the
        // same reason.
        seq: null,
        unityRow: snap.source === 'logEntries' ? row.seq : null,
        file: row.file || null,
        line: row.line || null,
        stackTrace: row.stackTrace,
        count: row.count,
      }));
      snapshotStatus = 'used';
    } catch {
      snapshotStatus = 'unavailable';
    }
  }

  return collectNewProblems({
    baseline,
    ring: unity.logs.map(ringEntry),
    snapshot,
    snapshotStatus,
    connected: unity.connected,
    bridgeProtocol: unity.bridgeProtocol,
    editorAwake: unity.editorAwake,
    compileErrors: freshCompileErrors(pass, baseline.compileIdentity),
    testRun: run,
  });
}
