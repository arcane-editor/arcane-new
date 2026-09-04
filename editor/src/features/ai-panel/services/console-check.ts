// Post-turn console check (Task 13, B5) — the pure core.
//
// The per-write gates repair what a COMPILER can see. Nothing looked at what
// Unity itself said after the turn: a NullReferenceException the agent's change
// introduced, a compiler error the compile gate never got a report for (Unity
// parked in the background), or a test the agent ran and left failing. All
// three are "the agent said done and it isn't". This module decides, from
// facts alone, what appeared during the turn and whether it is worth ONE
// bounded repair pass.
//
// PURE and Bun-safe (Global Constraint 4): no store imports, no Tauri, no
// bridge RPC. `agent-service.ts` reads `stores/unity.ts` and calls
// `bridgeRpc.getConsoleSnapshot` itself, then hands the facts in here.
//
// ---------------------------------------------------------------------------
// What counts as "new this turn"
// ---------------------------------------------------------------------------
// The session ring is the authority. Every `UnityLogEntry.seq` is a
// client-side monotonic id assigned on ingest (see `stores/unity.ts`), so
// `seq > baseline.seq` is the only comparison that means "after this send
// started". Unity's own console row index (`unityRow`, and a snapshot row's
// wire `seq`) is a different, incomparable numbering.
//
// The epoch is NOT part of that comparison. `backfillConsoleHistory` bumps
// `consoleEpoch` while PREPENDING Unity's console history to `logs`
// (`stores/unity.ts`), and a reconnect re-arms it — so "the epoch moved, take
// the whole ring" turned a mid-turn reconnect into "every error Unity has ever
// shown happened during this turn". `clearLogs()` does not reset `logSeq`, so
// `seq > baseline.seq` is already correct after a real clear; the epoch is kept
// on the baseline only as the recorded state of the console at send start.
//
// Two entries are deliberately excluded:
//
//   * `historical: true` — backfilled from Unity's console on connect. Those
//     rows are assigned a FRESH `seq` on ingest, so counting them would again
//     present Unity's whole history as this turn's. Their PRESENCE past the
//     baseline is still a fact, and an important one: it means the bridge
//     reconnected mid-turn and the ring is no longer a complete record, which
//     is reported as the `reconnected` degradation rather than swallowed.
//   * `[UnityIDEBridge]`-prefixed messages — this IDE's own bridge talking
//     about itself (`arcane-extension/Editor/BridgeBootstrap.cs`). Never the
//     project's bug.
//
// A `getConsoleSnapshot` read (protocol 4+, connected) is merged in two ways:
//
//   * ENRICHMENT. An exact key match takes Unity's collapsed `count`. A LOOSE
//     match (`logType|firstLine`) against a ring entry that has no location at
//     all — its stack trace did not parse — takes the snapshot's `file:line`,
//     which is the only way such an entry ever stops being classified as
//     `external`. (Matching on the full key alone could never do this: the
//     location is part of the key, so the two twins never met.)
//   * ADOPTION, for the domain-reload gap. A snapshot row that matches nothing
//     in the ring is adopted only when its Unity console row index
//     (`unityRow`) is beyond the high-water mark recorded at send start. With
//     no high-water mark there is nothing to compare against and the row is
//     NOT adopted (`snapshotAdoption: 'no-baseline'`) — "it is in Unity's
//     console" is not on its own evidence that it arrived during this turn.
//
// The snapshot RPC fails outright whenever Unity is parked in the background;
// that is recorded as `snapshot: 'unavailable'` and is never an error of the
// check.

import { parseStackTrace, type StackFrame, type UnityLogType } from '../../../types/unity';
import { REPAIR_MAX_FRAMES, type RepairPromptProblem } from './prompts/console-repair';

/** One repair pass per send. Not a tunable: a second pass is a loop, not a fix. */
export const MAX_CONSOLE_REPAIRS = 1;

/** Extra model calls granted to the repair pass (mirrors `runGroundingLint`'s `grantExtraCalls(1)`). */
export const CONSOLE_REPAIR_CALL_GRANT = 6;

/** Console problems carried into the card and the repair prompt, most recent first. */
export const MAX_CONSOLE_ITEMS = 8;

/** Compiler errors listed verbatim in the repair prompt. */
export const MAX_COMPILE_ITEMS = 8;

/** Rows requested from `getConsoleSnapshot`. */
export const CONSOLE_SNAPSHOT_LIMIT = 100;

/** `getConsoleSnapshot` exists from bridge protocol 4 (mirrors `read-tools.ts`). */
export const CONSOLE_MIN_PROTOCOL = 4;

/** Warnings never trigger anything — only these do. */
export const CONSOLE_ERROR_TYPES: readonly UnityLogType[] = [
  'Error',
  'Assert',
  'Exception',
  'CompileError',
];

const ERROR_TYPE_SET = new Set<UnityLogType>(CONSOLE_ERROR_TYPES);

/** This IDE's own bridge chatter — never the project's bug. */
const BRIDGE_MESSAGE_PREFIX = '[UnityIDEBridge]';

// ---- Baseline ----

/**
 * The per-send console baseline, captured in `runSend` right after
 * `beginVerifiedPass()`.
 *
 * Richer than `markConsoleTurnStart`'s bare seq (which the
 * `get_console_errors sinceTurnStart` tool keeps using) because this check has
 * to answer three more questions honestly: is the compile report on the store
 * from THIS turn (`compileIdentity`), was Unity awake at any point in the
 * window (`editorAwake`, so "no errors" is never reported as clean for an
 * editor that was parked the whole time), and how far had Unity's own console
 * got by the time the send started (`maxUnityRow`, the only thing that can
 * date a `getConsoleSnapshot` row).
 */
export interface ConsoleCheckBaseline {
  /** `stores/unity.ts`'s `logSeq` at send start. */
  seq: number;
  /**
   * `consoleEpoch` at send start. Recorded state only — deliberately NOT part
   * of the "is this entry new" test (see the header): a backfill moves it
   * without anything having been cleared.
   */
  epoch: number;
  startedAt: number;
  /** `lastCompilation.receivedAt` at send start, or `null` when there was none. */
  compileIdentity: number | null;
  /** Whether Unity's main thread was servicing work at send start. */
  editorAwake: boolean;
  /**
   * Highest Unity console row index (`UnityLogEntry.unityRow`) the ring held at
   * send start, or `null` when nothing in the ring had ever been backfilled
   * from Unity's own console. It is the ONLY thing that can date a
   * `getConsoleSnapshot` row, so with no high-water mark no snapshot-only row
   * is ever adopted.
   */
  maxUnityRow: number | null;
}

let baseline: ConsoleCheckBaseline | null = null;
let repairAttempts = 0;

/** Reset the console-check registry. Call once at the start of every user send. */
export function beginConsoleCheck(next: ConsoleCheckBaseline): void {
  baseline = next;
  repairAttempts = 0;
}

/** The baseline captured for the send in flight, or `null` if none was captured. */
export function consoleCheckBaseline(): ConsoleCheckBaseline | null {
  return baseline;
}

/** Repair passes already spent this send — the `shouldRepair` bound. */
export function consoleRepairAttempts(): number {
  return repairAttempts;
}

/** Called immediately before a repair pass prompts the model. */
export function recordConsoleRepairAttempt(): void {
  repairAttempts++;
}

// ---- Inputs ----

/** A console entry, normalized from either a ring `UnityLogEntry` or a snapshot row. */
export interface ConsoleEntryInput {
  logType: UnityLogType;
  message: string;
  /**
   * The client-side monotonic ring id, or `null` for a snapshot row (Unity's
   * row index lives in a different numbering and is never comparable).
   */
  seq: number | null;
  file?: string | null;
  line?: number | null;
  stackTrace?: string | null;
  parsedFrames?: StackFrame[];
  /** Backfilled from Unity's console on connect — it predates this turn. */
  historical?: boolean;
  /** Unity's own collapsed repeat count, present on snapshot rows. */
  count?: number;
  /**
   * Unity's own console row index. Present on every snapshot row and on ring
   * entries that were backfilled. Monotonic within Unity's console, and the
   * only ordering a snapshot row carries — never comparable to `seq`.
   */
  unityRow?: number | null;
}

export interface CompileProblem {
  file: string;
  line: number;
  message: string;
}

export interface TestFailureProblem {
  fullName: string;
  message: string;
}

/** The subset of a `TestRunCompletedPayload` this check reads. */
export interface TestRunSummaryInput {
  mode?: string;
  passed?: number;
  failed?: number;
  skipped?: number;
  failures?: Array<{ fullName: string; message: string }>;
}

export type SnapshotStatus = 'used' | 'unavailable' | 'not-attempted';

export interface CollectInput {
  baseline: ConsoleCheckBaseline;
  /** The whole session ring, unfiltered — the baseline filter is applied here. */
  ring: ConsoleEntryInput[];
  /** Rows from `getConsoleSnapshot`, or `null` when it was not attempted or failed. */
  snapshot: ConsoleEntryInput[] | null;
  snapshotStatus: SnapshotStatus;
  connected: boolean;
  bridgeProtocol: number | null;
  /** Whether Unity's main thread is servicing work now. */
  editorAwake: boolean;
  /** Compiler errors from the fresh post-turn compile report (empty when clean or unknown). */
  compileErrors: CompileProblem[];
  /** The latest test run recorded this send, or `null` when none ran. */
  testRun: TestRunSummaryInput | null;
}

// ---- Outputs ----

export interface ConsoleProblem {
  key: string;
  logType: UnityLogType;
  firstLine: string;
  /** `file:line` of the first in-`Assets/` frame, or `null`. */
  location: string | null;
  count: number;
  /** No in-`Assets/` frame at all — a package or engine problem. Listed, never repaired. */
  external: boolean;
  /** Newest ring seq seen for this key, or 0 for a problem adopted from the snapshot. */
  seq: number;
  /**
   * True when this problem exists only because a `getConsoleSnapshot` row was
   * adopted — it never streamed to this IDE, so it has no ring seq and the
   * post-repair diff can only ever report it as "not seen again".
   */
  fromSnapshot: boolean;
  /** In-`Assets/` frames, for the repair prompt's code regions. */
  frames: StackFrame[];
}

/** Why the console read cannot be trusted to be complete. `null` when it can. */
export type ConsoleDegradation =
  | 'no-bridge'
  | 'editor-asleep'
  /** The bridge reconnected mid-turn and backfilled — the ring has a hole in it. */
  | 'reconnected'
  | 'old-package';

/** What the `getConsoleSnapshot` merge was able to do, for the record. */
export type SnapshotAdoption = 'adopted' | 'none-matched' | 'no-baseline' | 'not-attempted';

export interface CollectedProblems {
  /** Deduped problems, most recent first, capped at `MAX_CONSOLE_ITEMS`. */
  console: ConsoleProblem[];
  /** Distinct problem keys found BEFORE the cap — never understate the count. */
  consoleTotal: number;
  /** Distinct external keys found before the cap. */
  externalTotal: number;
  compile: CompileProblem[];
  tests: TestFailureProblem[];
  testRun: TestRunSummaryInput | null;
  degraded: ConsoleDegradation | null;
  /**
   * The bridge cannot answer for console history at all (protocol < 4), so
   * everything here came from this session's stream. Tracked separately from
   * `degraded` because it stays true — and stays worth saying — even when a
   * more urgent degradation outranks it.
   */
  streamOnly: boolean;
  snapshot: SnapshotStatus;
  snapshotAdoption: SnapshotAdoption;
}

// ---- Card data (the `console` / `tests` / `repair` fields of VerifiedCardData) ----

export interface ConsoleCardItem {
  logType: UnityLogType;
  firstLine: string;
  location: string | null;
  count: number;
  /** No in-`Assets/` frame — a package or engine problem, listed but never repaired. */
  external: boolean;
}

export type ConsoleCheckResult =
  /** Ran, found nothing. */
  | 'clean'
  /** Did not run at all (not a Unity send, or the setting is off). No chip. */
  | 'skipped'
  /** Ran, but cannot say — never rendered as a pass. */
  | { unknown: ConsoleDegradation }
  /**
   * The repair ran, but the read that was supposed to judge it could not be
   * trusted (the bridge dropped, Unity went to sleep, it reconnected). Nothing
   * was proven either way, so this must never render as a repaired outcome.
   */
  | { repairAttempted: true; recheck: ConsoleDegradation }
  | {
      newErrors: number;
      external: number;
      repaired: boolean;
      fixed: number;
      notReobserved: number;
      remaining: number;
      /** Protocol < 4: this is the session stream only, not Unity's history. */
      streamOnly: boolean;
      items: ConsoleCardItem[];
    };

export type TestsCheckResult =
  | 'skipped'
  | {
      mode: string;
      passed: number;
      failed: number;
      skipped: number;
      failures: TestFailureProblem[];
    };

export interface RepairInfo {
  attempted: true;
  trigger: 'console' | 'compile' | 'tests' | 'mixed';
  /** The user pressed Stop while the repair pass was running — nothing was re-checked. */
  interrupted?: true;
}

// ---- Keying ----

export function firstLine(message: string): string {
  return (message.split('\n')[0] ?? '').trim();
}

function framesOf(entry: ConsoleEntryInput): StackFrame[] {
  return entry.parsedFrames ?? parseStackTrace(entry.stackTrace ?? '');
}

/** In-`Assets/` frames of an entry, in trace order. */
export function projectFrames(entry: ConsoleEntryInput): StackFrame[] {
  return framesOf(entry).filter((f) => /Assets\//.test(f.filePath));
}

/**
 * `file:line` of the first frame inside `Assets/`, falling back to the entry's
 * own `file`/`line` when that is under `Assets/` too (snapshot rows carry it
 * even when the trace does not parse). `null` means nothing in this project
 * appears anywhere in the entry — i.e. it is `external`.
 */
export function problemLocation(entry: ConsoleEntryInput): string | null {
  const frame = projectFrames(entry)[0];
  if (frame) return `${frame.filePath}:${frame.lineNumber}`;
  if (entry.file && /Assets\//.test(entry.file)) return `${entry.file}:${entry.line ?? 0}`;
  return null;
}

/** `logType | first line | first in-project frame` — stable across the ring and a snapshot row. */
export function problemKey(entry: ConsoleEntryInput): string {
  return `${entry.logType}|${firstLine(entry.message)}|${problemLocation(entry) ?? ''}`;
}

// ---- Collection ----

function isRepairableType(logType: UnityLogType): boolean {
  return ERROR_TYPE_SET.has(logType);
}

function isBridgeChatter(message: string): boolean {
  return message.trimStart().startsWith(BRIDGE_MESSAGE_PREFIX);
}

/**
 * Entries that arrived during this send.
 *
 * `seq > baseline.seq` and nothing else. There used to be an "if the epoch
 * moved, take the whole ring" branch on the theory that a clear empties it;
 * `backfillConsoleHistory` moves the epoch too, while PREPENDING history, so
 * that branch turned every mid-turn reconnect into a repair pass aimed at
 * hours-old errors. `clearLogs()` leaves `logSeq` alone, so the seq test is
 * already right after a real clear.
 */
export function selectNewEntries(
  ring: ConsoleEntryInput[],
  base: ConsoleCheckBaseline,
): ConsoleEntryInput[] {
  return ring.filter((e) => {
    if (e.historical) return false;
    if (!isRepairableType(e.logType)) return false;
    if (isBridgeChatter(e.message)) return false;
    return (e.seq ?? 0) > base.seq;
  });
}

/**
 * Did the bridge reconnect and backfill during this send?
 *
 * A backfilled row is stamped `historical` and given a fresh ring `seq` on
 * ingest, so a historical row sitting past the baseline is exactly the
 * fingerprint of a mid-turn reconnect — and it means the live stream has a
 * hole in it for however long the bridge was gone.
 */
export function detectReconnect(ring: ConsoleEntryInput[], base: ConsoleCheckBaseline): boolean {
  return ring.some((e) => e.historical === true && (e.seq ?? 0) > base.seq);
}

/** `logType|firstLine` — matches a snapshot row to a ring entry whose trace never parsed. */
function looseKey(entry: { logType: UnityLogType; message?: string; firstLine?: string }): string {
  const line = entry.firstLine ?? firstLine(entry.message ?? '');
  return `${entry.logType}|${line}`;
}

function degradationOf(input: CollectInput, reconnected: boolean): ConsoleDegradation | null {
  if (!input.connected) return 'no-bridge';
  // Ahead of liveness: a hole in the record is a fact about the record, and it
  // stays true whether or not Unity happens to be awake right now.
  if (reconnected) return 'reconnected';
  // Parked at BOTH ends of the window: nothing could have streamed, so silence
  // is not evidence. An editor that woke up at any point did stream.
  if (!input.editorAwake && !input.baseline.editorAwake) return 'editor-asleep';
  if (input.bridgeProtocol != null && input.bridgeProtocol < CONSOLE_MIN_PROTOCOL) {
    return 'old-package';
  }
  return null;
}

/**
 * Everything this turn left behind: deduped console errors, the fresh
 * compile's errors, and the latest test run's failures.
 */
export function collectNewProblems(input: CollectInput): CollectedProblems {
  const fresh = selectNewEntries(input.ring, input.baseline);

  const byKey = new Map<string, ConsoleProblem>();
  for (const entry of fresh) {
    const key = problemKey(entry);
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      existing.seq = Math.max(existing.seq, entry.seq ?? 0);
      if (existing.frames.length === 0) existing.frames = projectFrames(entry).slice(0, REPAIR_MAX_FRAMES);
      continue;
    }
    const location = problemLocation(entry);
    byKey.set(key, {
      key,
      logType: entry.logType,
      firstLine: firstLine(entry.message),
      location,
      count: 1,
      external: location === null,
      seq: entry.seq ?? 0,
      fromSnapshot: false,
      frames: projectFrames(entry).slice(0, REPAIR_MAX_FRAMES),
    });
  }

  // Ring entries with no location at all — a snapshot row is the only thing
  // that can give them one, and their full key can never match it.
  const locationless = new Map<string, ConsoleProblem>();
  for (const p of byKey.values()) {
    if (p.location === null && !locationless.has(looseKey(p))) locationless.set(looseKey(p), p);
  }

  let adoption: SnapshotAdoption =
    input.snapshotStatus === 'used' ? 'none-matched' : 'not-attempted';

  for (const row of input.snapshot ?? []) {
    if (!isRepairableType(row.logType)) continue;
    if (isBridgeChatter(row.message)) continue;

    const exact = byKey.get(problemKey(row));
    if (exact) {
      if (row.count != null && row.count > exact.count) exact.count = row.count;
      if (exact.frames.length === 0) exact.frames = projectFrames(row).slice(0, REPAIR_MAX_FRAMES);
      continue;
    }

    // Enrichment: give a location-less ring entry the snapshot's `file:line`.
    // This is the only path by which such an entry stops being `external`, so
    // it is also the only path by which it becomes repairable at all.
    const loose = locationless.get(looseKey(row));
    const rowLocation = problemLocation(row);
    if (loose && rowLocation) {
      byKey.delete(loose.key);
      locationless.delete(looseKey(loose));
      loose.location = rowLocation;
      loose.external = false;
      loose.key = `${loose.logType}|${loose.firstLine}|${rowLocation}`;
      if (loose.frames.length === 0) loose.frames = projectFrames(row).slice(0, REPAIR_MAX_FRAMES);
      if (row.count != null && row.count > loose.count) loose.count = row.count;
      byKey.set(loose.key, loose);
      continue;
    }
    if (loose) continue; // Matched, but the snapshot has no project location either.

    // Adoption — the domain-reload gap. Only Unity's own row index can date a
    // snapshot row, and only against a high-water mark taken at send start.
    if (input.baseline.maxUnityRow == null) {
      adoption = 'no-baseline';
      continue;
    }
    if (row.unityRow == null || row.unityRow <= input.baseline.maxUnityRow) continue;
    const key = problemKey(row);
    if (byKey.has(key)) continue;
    byKey.set(key, {
      key,
      logType: row.logType,
      firstLine: firstLine(row.message),
      location: rowLocation,
      count: row.count ?? 1,
      external: rowLocation === null,
      // No ring seq exists for a row that never streamed here.
      seq: 0,
      fromSnapshot: true,
      frames: projectFrames(row).slice(0, REPAIR_MAX_FRAMES),
    });
    adoption = 'adopted';
  }

  const all = [...byKey.values()].sort((a, b) => b.seq - a.seq);

  const testRun = input.testRun;
  const tests = (testRun?.failures ?? []).map((f) => ({
    fullName: f.fullName,
    message: f.message,
  }));

  const reconnected = detectReconnect(input.ring, input.baseline);

  return {
    console: all.slice(0, MAX_CONSOLE_ITEMS),
    consoleTotal: all.length,
    externalTotal: all.filter((p) => p.external).length,
    compile: input.compileErrors,
    tests,
    testRun,
    degraded: degradationOf(input, reconnected),
    streamOnly:
      input.bridgeProtocol != null && input.bridgeProtocol < CONSOLE_MIN_PROTOCOL,
    snapshot: input.snapshotStatus,
    snapshotAdoption: adoption,
  };
}

// ---- The repair decision ----

export interface RepairGateOptions {
  /** `unity.consoleCheck.autoRepair` — false only when the user turned it off. */
  autoRepair: boolean;
  aborted: boolean;
  connected: boolean;
}

/** Problems a repair pass could actually act on — external console entries are not among them. */
export function repairableCount(problems: CollectedProblems): number {
  const own = problems.console.filter((p) => !p.external).length;
  return own + problems.compile.length + problems.tests.length;
}

export function shouldRepair(
  problems: CollectedProblems,
  attempts: number,
  opts: RepairGateOptions,
): boolean {
  if (attempts >= MAX_CONSOLE_REPAIRS) return false;
  if (!opts.autoRepair) return false;
  if (opts.aborted) return false;
  if (!opts.connected) return false;
  return repairableCount(problems) > 0;
}

export function repairTrigger(problems: CollectedProblems): RepairInfo['trigger'] | null {
  const flags = [
    problems.console.some((p) => !p.external),
    problems.compile.length > 0,
    problems.tests.length > 0,
  ];
  const set = flags.filter(Boolean).length;
  if (set === 0) return null;
  if (set > 1) return 'mixed';
  return flags[0] ? 'console' : flags[1] ? 'compile' : 'tests';
}

// ---- After the repair ----

export interface RepairOutcome {
  /** Proven gone by fresh evidence — compiler errors, when the new report is CLEAN. */
  fixed: number;
  /** Did not appear again. Absence is not proof; the card says so. */
  notReobserved: number;
  /** Observed AGAIN after the repair began, or never re-checked at all. */
  remaining: number;
}

export interface RepairEvidence {
  /** Ring seq at the moment the repair prompt went out. */
  repairStartSeq: number;
  /**
   * Whether the POST-repair verified pass produced a clean compile REPORT.
   *
   * Not "no errors came back": a compile that was skipped, timed out, or ran
   * against a parked editor also has no errors to hand over, and treating that
   * as a clean report reported every compiler error as fixed on the strength
   * of a compile that never happened.
   */
  secondCompileClean: boolean;
}

/**
 * Compare the pre- and post-repair collections.
 *
 * A console error can only ever be `notReobserved`: nothing short of
 * re-entering Play Mode and reproducing the path proves it gone, and the card
 * must not pretend otherwise. `remaining` requires positive evidence — the
 * same key seen again at a ring seq newer than the moment the repair started.
 *
 * Compiler errors are the one thing that CAN be proven, because the post-repair
 * pass compiles again — but only when that compile actually produced a clean
 * report. Anything else leaves them counted as `remaining`.
 */
export function diffAfterRepair(
  before: CollectedProblems,
  after: CollectedProblems,
  evidence: RepairEvidence,
): RepairOutcome {
  const afterByKey = new Map(after.console.map((p) => [p.key, p]));
  let notReobserved = 0;
  let remaining = 0;
  for (const item of before.console) {
    if (item.external) continue;
    const again = afterByKey.get(item.key);
    if (again && again.seq > evidence.repairStartSeq) remaining++;
    else notReobserved++;
  }
  // BOTH conditions, deliberately: the fresh pass must have said "clean", and
  // the re-collection must have found no errors to report. Either one alone is
  // satisfied by a compile that never ran.
  const compileProven =
    before.compile.length > 0 && evidence.secondCompileClean && after.compile.length === 0;
  const fixed = compileProven ? before.compile.length : 0;
  if (before.compile.length > 0 && !compileProven) remaining += before.compile.length;
  return { fixed, notReobserved, remaining };
}

// ---- Card data ----

export function consoleResult(
  before: CollectedProblems,
  outcome: RepairOutcome | null,
  after: CollectedProblems | null = null,
): ConsoleCheckResult {
  // A dropped bridge is the one degradation that overrides everything: with no
  // connection there is no console to read, so nothing here can be a verdict.
  if (before.degraded === 'no-bridge') return { unknown: 'no-bridge' };

  // The repair ran and the read that was supposed to judge it was degraded —
  // an empty `after` then means "we could not look", not "it is gone". Without
  // this branch every item fell through to `notReobserved` and the row read as
  // a successful repair.
  //
  // A degradation the FIRST read already had is not a fresh obstacle: both
  // halves then read the same ring under the same conditions, so the diff
  // between them is still meaningful and the detail is worth more than the
  // caveat. Only something that went wrong between the two reads invalidates
  // the comparison.
  if (outcome !== null && after !== null && after.degraded !== null && after.degraded !== before.degraded) {
    return { repairAttempted: true, recheck: after.degraded };
  }

  const nothingToShow =
    before.consoleTotal === 0 &&
    (outcome === null ||
      (outcome.fixed === 0 && outcome.notReobserved === 0 && outcome.remaining === 0));

  if (nothingToShow) {
    // A degraded read that found nothing is exactly the case that would
    // otherwise read as success (Global Constraint 2).
    return before.degraded ? { unknown: before.degraded } : 'clean';
  }

  return {
    newErrors: before.consoleTotal,
    external: before.externalTotal,
    repaired: outcome !== null,
    fixed: outcome?.fixed ?? 0,
    notReobserved: outcome?.notReobserved ?? 0,
    remaining: outcome?.remaining ?? 0,
    streamOnly: before.streamOnly,
    items: before.console.map((p) => ({
      logType: p.logType,
      firstLine: p.firstLine,
      location: p.location,
      count: p.count,
      external: p.external,
    })),
  };
}

/** The card's tests row, read from the LATEST recorded run (a re-run supersedes an earlier one). */
export function testsResult(run: TestRunSummaryInput | null): TestsCheckResult {
  if (!run) return 'skipped';
  return {
    mode: run.mode ?? 'EditMode',
    passed: run.passed ?? 0,
    failed: run.failed ?? 0,
    skipped: run.skipped ?? 0,
    failures: (run.failures ?? []).map((f) => ({ fullName: f.fullName, message: f.message })),
  };
}

// ---- The repair prompt's inputs ----

/** The console problems a repair pass is allowed to act on, plus the external ones for context. */
export function repairPromptProblems(problems: CollectedProblems): RepairPromptProblem[] {
  return problems.console.map((p) => ({
    logType: p.logType,
    firstLine: p.firstLine,
    location: p.location,
    count: p.count,
    external: p.external,
  }));
}

/** Frames whose code regions the repair prompt embeds — the first two of each own problem. */
export function repairPromptFrames(problems: CollectedProblems): StackFrame[] {
  return problems.console.filter((p) => !p.external).flatMap((p) => p.frames);
}

export function repairPromptCompileErrors(problems: CollectedProblems): CompileProblem[] {
  return problems.compile.slice(0, MAX_COMPILE_ITEMS);
}

// ---- Notices ----

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function joinParts(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The system message shown when a repair pass is about to run. Compiler errors
 * on their own get their own sentence — they did not "appear during" the turn,
 * they survived it.
 */
export function repairNotice(problems: CollectedProblems): string {
  const own = problems.console.filter((p) => !p.external).length;
  const compile = problems.compile.length;
  const tests = problems.tests.length;

  if (own === 0 && tests === 0 && compile > 0) {
    return `Console check — ${plural(compile, 'compiler error')} remain after this turn; asking the AI to fix them (one pass).`;
  }

  const parts: string[] = [];
  if (own > 0) parts.push(plural(own, 'new error'));
  if (compile > 0) parts.push(plural(compile, 'compiler error'));
  if (tests > 0) parts.push(plural(tests, 'failed test'));
  return `Console check — ${joinParts(parts)} appeared during this turn; asking the AI to fix them (one pass).`;
}

/** Shown when the only new errors came from outside the project — nothing to repair. */
export const EXTERNAL_ONLY_NOTICE =
  'Console check — new errors came from packages or the engine, not this project; nothing to fix automatically.';

/** True when the turn produced console errors but every one of them is someone else's. */
export function isExternalOnly(problems: CollectedProblems): boolean {
  return (
    problems.consoleTotal > 0 &&
    problems.externalTotal === problems.consoleTotal &&
    problems.compile.length === 0 &&
    problems.tests.length === 0
  );
}

// ---- Row copy ----

/**
 * The console row on the Verified card.
 *
 * Every degraded branch names what is missing and what to do about it — a row
 * that simply said "console clean" for an editor that was asleep, a bridge
 * that was gone, or a package that cannot answer for history would be the
 * card's most expensive lie (Global Constraint 2).
 */
export function consoleRowLabel(result: ConsoleCheckResult): string {
  if (result === 'skipped') return 'console skipped';
  if (result === 'clean') return 'console clean';
  if ('unknown' in result) {
    switch (result.unknown) {
      case 'no-bridge':
        return 'console (no Unity bridge)';
      case 'editor-asleep':
        return 'console unknown (Unity in background)';
      case 'reconnected':
        return 'console unknown (Unity reconnected mid-turn — history may be incomplete)';
      case 'old-package':
        return 'console: stream only (update the bridge package for full history)';
    }
  }
  if ('repairAttempted' in result) {
    return `console: repair attempted, re-check unavailable (${RECHECK_REASON[result.recheck]})`;
  }
  const body =
    result.fixed > 0 || result.remaining > 0
      ? `console: ${result.fixed} fixed, ${result.remaining} remaining`
      : result.notReobserved > 0
        ? `console: ${result.notReobserved} not seen again (needs Play Mode to confirm)`
        : `console: ${plural(result.newErrors, 'new error')}`;
  // The stream-only caveat survives finding problems: what the row cannot say
  // either way is how many MORE there were before this session started
  // listening.
  return result.streamOnly
    ? `${body} (stream only — update the bridge package for full history)`
    : body;
}

const RECHECK_REASON: Record<ConsoleDegradation, string> = {
  'no-bridge': 'no Unity bridge',
  'editor-asleep': 'Unity in background',
  reconnected: 'Unity reconnected mid-turn',
  'old-package': 'stream only — update the bridge package for full history',
};

/** The tests row on the Verified card. */
export function testsRowLabel(result: TestsCheckResult): string {
  if (result === 'skipped') return 'tests skipped';
  if (result.failed > 0) {
    const total = result.passed + result.failed + result.skipped;
    return `tests: ${result.failed} of ${total} failed`;
  }
  return `tests: ${result.passed} passed`;
}
