import { describe, it, expect, beforeEach } from 'bun:test';
import {
  MAX_CONSOLE_REPAIRS,
  CONSOLE_REPAIR_CALL_GRANT,
  MAX_CONSOLE_ITEMS,
  CONSOLE_MIN_PROTOCOL,
  CONSOLE_ERROR_TYPES,
  beginConsoleCheck,
  consoleCheckBaseline,
  consoleRepairAttempts,
  recordConsoleRepairAttempt,
  collectNewProblems,
  selectNewEntries,
  problemKey,
  problemLocation,
  shouldRepair,
  repairableCount,
  repairTrigger,
  diffAfterRepair,
  consoleResult,
  testsResult,
  repairNotice,
  isExternalOnly,
  EXTERNAL_ONLY_NOTICE,
  repairPromptProblems,
  repairPromptFrames,
  consoleRowLabel,
  testsRowLabel,
  detectReconnect,
  type CollectInput,
  type CollectedProblems,
  type ConsoleProblem,
  type ConsoleCheckBaseline,
  type ConsoleEntryInput,
} from './console-check';

const BASE: ConsoleCheckBaseline = {
  seq: 10,
  epoch: 1,
  startedAt: 1_000,
  compileIdentity: null,
  editorAwake: true,
  maxUnityRow: null,
};

function entry(overrides: Partial<ConsoleEntryInput> = {}): ConsoleEntryInput {
  return {
    logType: 'Exception',
    message: 'NullReferenceException: Object reference not set\n  more detail',
    seq: 11,
    stackTrace: 'Player.Update () (at Assets/Scripts/Player.cs:42)',
    ...overrides,
  };
}

function input(overrides: Partial<CollectInput> = {}): CollectInput {
  return {
    baseline: BASE,
    ring: [],
    snapshot: null,
    snapshotStatus: 'not-attempted',
    connected: true,
    bridgeProtocol: 4,
    editorAwake: true,
    compileErrors: [],
    testRun: null,
    ...overrides,
  };
}

function collected(overrides: Partial<CollectedProblems> = {}): CollectedProblems {
  return {
    console: [],
    consoleTotal: 0,
    externalTotal: 0,
    compile: [],
    tests: [],
    testRun: null,
    degraded: null,
    streamOnly: false,
    snapshot: 'not-attempted',
    snapshotAdoption: 'not-attempted',
    ...overrides,
  };
}

function problem(over: Partial<ConsoleProblem> = {}): ConsoleProblem {
  return {
    key: 'k',
    logType: 'Exception',
    firstLine: 'boom',
    location: 'Assets/A.cs:1',
    count: 1,
    external: false,
    seq: 11,
    fromSnapshot: false,
    frames: [],
    ...over,
  };
}

describe('the per-send registry', () => {
  beforeEach(() => beginConsoleCheck(BASE));

  it('stores the baseline and starts with no repair attempts spent', () => {
    expect(consoleCheckBaseline()).toEqual(BASE);
    expect(consoleRepairAttempts()).toBe(0);
  });

  it('counts attempts and clears them on the next send', () => {
    recordConsoleRepairAttempt();
    expect(consoleRepairAttempts()).toBe(1);
    beginConsoleCheck({ ...BASE, seq: 99 });
    expect(consoleRepairAttempts()).toBe(0);
    expect(consoleCheckBaseline()?.seq).toBe(99);
  });
});

describe('selectNewEntries', () => {
  it('keeps only entries newer than the baseline seq', () => {
    const kept = selectNewEntries(
      [entry({ seq: 9 }), entry({ seq: 10 }), entry({ seq: 11 })],
      BASE,
    );
    expect(kept.map((e) => e.seq)).toEqual([11]);
  });

  // The regression. `backfillConsoleHistory` bumps `consoleEpoch` while
  // PREPENDING Unity's history to the ring, so "the epoch moved, take
  // everything" turned every mid-turn reconnect into a repair pass aimed at
  // hours-old errors. `clearLogs()` leaves `logSeq` alone, so the seq test is
  // already correct after a real clear.
  it('never selects an entry at or below the baseline seq, whatever the epoch did', () => {
    const older = [entry({ seq: 1 }), entry({ seq: 9 }), entry({ seq: 10 })];
    expect(selectNewEntries(older, BASE)).toHaveLength(0);
    expect(collectNewProblems(input({ ring: older, snapshotStatus: 'not-attempted' })).consoleTotal).toBe(0);
  });

  it('drops entries backfilled from Unity\'s own console history', () => {
    const kept = selectNewEntries([entry({ seq: 11, historical: true })], BASE);
    expect(kept).toHaveLength(0);
  });

  it('drops warnings and logs — only Error/Assert/Exception/CompileError trigger anything', () => {
    const kept = selectNewEntries(
      [
        entry({ seq: 11, logType: 'Warning' }),
        entry({ seq: 12, logType: 'Log' }),
        entry({ seq: 13, logType: 'CompileWarning' }),
        entry({ seq: 14, logType: 'Assert' }),
      ],
      BASE,
    );
    expect(kept.map((e) => e.logType)).toEqual(['Assert']);
    expect([...CONSOLE_ERROR_TYPES]).toEqual(['Error', 'Assert', 'Exception', 'CompileError']);
  });

  it("drops this IDE's own bridge chatter", () => {
    const kept = selectNewEntries(
      [
        entry({ seq: 11, message: '[UnityIDEBridge] update pump error: boom' }),
        entry({ seq: 12, message: 'Real problem' }),
      ],
      BASE,
    );
    expect(kept.map((e) => e.message)).toEqual(['Real problem']);
  });
});

describe('the dedup key', () => {
  it('is logType + first message line + the first in-project frame', () => {
    expect(problemKey(entry())).toBe(
      'Exception|NullReferenceException: Object reference not set|Assets/Scripts/Player.cs:42',
    );
  });

  it('collapses two entries that differ only past the first message line', () => {
    const a = entry({ message: 'Boom\nstack a' });
    const b = entry({ message: 'Boom\nstack b' });
    expect(problemKey(a)).toBe(problemKey(b));
  });

  it('separates the same message thrown from two different lines', () => {
    const a = entry({ stackTrace: 'Player.Update () (at Assets/Scripts/Player.cs:42)' });
    const b = entry({ stackTrace: 'Player.Update () (at Assets/Scripts/Player.cs:43)' });
    expect(problemKey(a)).not.toBe(problemKey(b));
  });

  it('falls back to the entry\'s own file:line when the trace does not parse', () => {
    expect(problemLocation(entry({ stackTrace: 'garbage', file: 'Assets/A.cs', line: 7 }))).toBe(
      'Assets/A.cs:7',
    );
  });

  it('ignores a file outside Assets/ for the location', () => {
    expect(
      problemLocation(entry({ stackTrace: '', file: 'Library/PackageCache/x/B.cs', line: 7 })),
    ).toBeNull();
  });
});

describe('collectNewProblems', () => {
  it('collapses repeats into one problem with a count', () => {
    const out = collectNewProblems(
      input({ ring: [entry({ seq: 11 }), entry({ seq: 12 }), entry({ seq: 13 })] }),
    );
    expect(out.console).toHaveLength(1);
    expect(out.console[0].count).toBe(3);
    expect(out.console[0].seq).toBe(13);
    expect(out.consoleTotal).toBe(1);
  });

  it('classifies an entry with no in-Assets frame as external', () => {
    const out = collectNewProblems(
      input({
        ring: [
          entry({ seq: 11 }),
          entry({
            seq: 12,
            message: 'Shader error',
            stackTrace: 'UnityEngine.Thing.Do () (at Library/PackageCache/com.unity.x/A.cs:3)',
          }),
        ],
      }),
    );
    const external = out.console.filter((p) => p.external);
    expect(external).toHaveLength(1);
    expect(external[0].firstLine).toBe('Shader error');
    expect(external[0].location).toBeNull();
    expect(out.externalTotal).toBe(1);
  });

  it('caps the carried items at 8, most recent first, without understating the total', () => {
    const ring = Array.from({ length: 12 }, (_, i) =>
      entry({ seq: 11 + i, message: `Problem ${i}` }),
    );
    const out = collectNewProblems(input({ ring }));
    expect(out.console).toHaveLength(MAX_CONSOLE_ITEMS);
    expect(out.consoleTotal).toBe(12);
    expect(out.console[0].firstLine).toBe('Problem 11');
    expect(out.console[7].firstLine).toBe('Problem 4');
  });

  it('carries the first two in-Assets frames for the repair prompt', () => {
    const out = collectNewProblems(
      input({
        ring: [
          entry({
            seq: 11,
            stackTrace: [
              'Player.A () (at Assets/A.cs:1)',
              'Player.B () (at Assets/B.cs:2)',
              'Player.C () (at Assets/C.cs:3)',
            ].join('\n'),
          }),
        ],
      }),
    );
    expect(out.console[0].frames.map((f) => f.filePath)).toEqual(['Assets/A.cs', 'Assets/B.cs']);
  });

  it('merges a snapshot row into a matching key to pick up Unity\'s collapsed count', () => {
    const out = collectNewProblems(
      input({
        ring: [entry({ seq: 11 })],
        snapshot: [entry({ seq: null, unityRow: 500, count: 9 })],
        snapshotStatus: 'used',
      }),
    );
    expect(out.console).toHaveLength(1);
    expect(out.console[0].count).toBe(9);
    expect(out.snapshot).toBe('used');
  });

  // The merge used to be inert: the location is part of the dedup key, so a
  // ring entry whose trace never parsed could not match its own snapshot twin,
  // and the snapshot's `file:line` — the only thing that could stop it being
  // classified `external` — never reached it.
  it('gives a location-less ring entry the snapshot\'s file:line, so it stops being external', () => {
    const out = collectNewProblems(
      input({
        ring: [entry({ seq: 11, message: 'Boom', stackTrace: 'unparseable garbage' })],
        snapshot: [
          entry({
            seq: null,
            unityRow: 500,
            message: 'Boom',
            stackTrace: '',
            file: 'Assets/Scripts/Player.cs',
            line: 42,
          }),
        ],
        snapshotStatus: 'used',
      }),
    );
    expect(out.console).toHaveLength(1);
    expect(out.console[0].location).toBe('Assets/Scripts/Player.cs:42');
    expect(out.console[0].external).toBe(false);
    expect(out.externalTotal).toBe(0);
    // And it is now repairable, which it was not before the merge.
    expect(repairableCount(out)).toBe(1);
  });

  it('leaves a location-less entry external when the snapshot has no project location either', () => {
    const out = collectNewProblems(
      input({
        ring: [entry({ seq: 11, message: 'Boom', stackTrace: 'garbage' })],
        snapshot: [
          entry({
            seq: null,
            unityRow: 500,
            message: 'Boom',
            stackTrace: '',
            file: 'Library/PackageCache/x/A.cs',
            line: 3,
          }),
        ],
        snapshotStatus: 'used',
      }),
    );
    expect(out.consoleTotal).toBe(1);
    expect(out.console[0].external).toBe(true);
  });

  // The domain-reload gap: an error thrown while the bridge was down never
  // streamed, so only Unity's own console has it. Its row index is the only
  // thing that can date it.
  it('adopts a snapshot-only row whose Unity row index is past the send-start high-water mark', () => {
    const out = collectNewProblems(
      input({
        baseline: { ...BASE, maxUnityRow: 100 },
        ring: [],
        snapshot: [entry({ seq: null, unityRow: 101, message: 'Thrown across the reload' })],
        snapshotStatus: 'used',
      }),
    );
    expect(out.consoleTotal).toBe(1);
    expect(out.console[0].firstLine).toBe('Thrown across the reload');
    expect(out.console[0].fromSnapshot).toBe(true);
    expect(out.snapshotAdoption).toBe('adopted');
  });

  it('does not adopt a row at or below the high-water mark — it predates the send', () => {
    const out = collectNewProblems(
      input({
        baseline: { ...BASE, maxUnityRow: 100 },
        ring: [],
        snapshot: [
          entry({ seq: null, unityRow: 100, message: 'Old A' }),
          entry({ seq: null, unityRow: 4, message: 'Old B' }),
        ],
        snapshotStatus: 'used',
      }),
    );
    expect(out.consoleTotal).toBe(0);
    expect(out.snapshotAdoption).toBe('none-matched');
  });

  it('adopts nothing at all when there is no high-water mark to compare against', () => {
    const out = collectNewProblems(
      input({
        baseline: { ...BASE, maxUnityRow: null },
        ring: [],
        snapshot: [entry({ seq: null, unityRow: 9_999, message: 'An error from an hour ago' })],
        snapshotStatus: 'used',
      }),
    );
    expect(out.consoleTotal).toBe(0);
    expect(out.snapshotAdoption).toBe('no-baseline');
  });

  it('does not adopt a row that carries no Unity row index', () => {
    const out = collectNewProblems(
      input({
        baseline: { ...BASE, maxUnityRow: 100 },
        ring: [],
        snapshot: [entry({ seq: null, unityRow: null, message: 'Undateable' })],
        snapshotStatus: 'used',
      }),
    );
    expect(out.consoleTotal).toBe(0);
  });

  it('records an unavailable snapshot without turning it into an error of the check', () => {
    const out = collectNewProblems(
      input({ ring: [entry({ seq: 11 })], snapshot: null, snapshotStatus: 'unavailable' }),
    );
    expect(out.snapshot).toBe('unavailable');
    expect(out.console).toHaveLength(1);
    expect(out.degraded).toBeNull();
  });

  it('reports no-bridge when the bridge is disconnected', () => {
    expect(collectNewProblems(input({ connected: false })).degraded).toBe('no-bridge');
  });

  it('reports editor-asleep only when Unity was parked at BOTH ends of the window', () => {
    expect(collectNewProblems(input({ editorAwake: false })).degraded).toBeNull();
    expect(
      collectNewProblems(
        input({ editorAwake: false, baseline: { ...BASE, editorAwake: false } }),
      ).degraded,
    ).toBe('editor-asleep');
  });

  it('reports old-package below the console-snapshot protocol floor', () => {
    expect(collectNewProblems(input({ bridgeProtocol: 3 })).degraded).toBe('old-package');
    expect(collectNewProblems(input({ bridgeProtocol: CONSOLE_MIN_PROTOCOL })).degraded).toBeNull();
    // Unknown protocol is not a claim that the package is old.
    expect(collectNewProblems(input({ bridgeProtocol: null })).degraded).toBeNull();
  });

  it('tracks stream-only separately, so the caveat survives a more urgent degradation', () => {
    expect(collectNewProblems(input({ bridgeProtocol: 3 })).streamOnly).toBe(true);
    expect(
      collectNewProblems(input({ bridgeProtocol: 3, connected: false })).degraded,
    ).toBe('no-bridge');
    expect(collectNewProblems(input({ bridgeProtocol: 3, connected: false })).streamOnly).toBe(true);
    expect(collectNewProblems(input({ bridgeProtocol: 4 })).streamOnly).toBe(false);
  });

  // A historical row past the baseline is the fingerprint of a mid-turn
  // reconnect: the backfill stamps it and gives it a fresh ring seq. The rows
  // themselves are still excluded, but their presence means the live stream has
  // a hole in it and the check must not claim it saw everything.
  it('reports a mid-turn reconnect, and never calls that console clean', () => {
    const ring = [entry({ seq: 11, historical: true })];
    expect(detectReconnect(ring, BASE)).toBe(true);
    const out = collectNewProblems(input({ ring }));
    expect(out.consoleTotal).toBe(0);
    expect(out.degraded).toBe('reconnected');
    expect(consoleResult(out, null)).toEqual({ unknown: 'reconnected' });
  });

  it('does not call a pre-baseline historical row a reconnect', () => {
    expect(detectReconnect([entry({ seq: 9, historical: true })], BASE)).toBe(false);
    expect(collectNewProblems(input({ ring: [entry({ seq: 9, historical: true })] })).degraded).toBeNull();
  });

  it('still reports the problems it did find during a reconnect', () => {
    const out = collectNewProblems(
      input({ ring: [entry({ seq: 11, historical: true }), entry({ seq: 12 })] }),
    );
    expect(out.degraded).toBe('reconnected');
    expect(out.consoleTotal).toBe(1);
    expect(consoleResult(out, null)).toMatchObject({ newErrors: 1 });
  });

  it('carries the compile errors and the latest run\'s test failures through', () => {
    const out = collectNewProblems(
      input({
        compileErrors: [{ file: 'Assets/A.cs', line: 3, message: 'CS0103' }],
        testRun: {
          mode: 'EditMode',
          passed: 12,
          failed: 1,
          skipped: 0,
          failures: [{ fullName: 'T.Jumps', message: 'Expected: True' }],
        },
      }),
    );
    expect(out.compile).toHaveLength(1);
    expect(out.tests).toEqual([{ fullName: 'T.Jumps', message: 'Expected: True' }]);
  });
});

describe('shouldRepair', () => {
  const opts = { autoRepair: true, aborted: false, connected: true };
  const withOne = collected({ console: [problem()], consoleTotal: 1 });

  it('runs once when there is something repairable', () => {
    expect(shouldRepair(withOne, 0, opts)).toBe(true);
  });

  it('never runs a SECOND pass — MAX_CONSOLE_REPAIRS is 1', () => {
    expect(MAX_CONSOLE_REPAIRS).toBe(1);
    expect(shouldRepair(withOne, 1, opts)).toBe(false);
    expect(shouldRepair(withOne, 2, opts)).toBe(false);
  });

  it('does not run when nothing is repairable', () => {
    expect(shouldRepair(collected(), 0, opts)).toBe(false);
  });

  it('does not run for external-only problems — they are not this project\'s to fix', () => {
    const external = collected({
      console: [problem({ external: true, location: null })],
      consoleTotal: 1,
      externalTotal: 1,
    });
    expect(repairableCount(external)).toBe(0);
    expect(shouldRepair(external, 0, opts)).toBe(false);
  });

  it('runs for compile errors or failed tests alone', () => {
    expect(
      shouldRepair(collected({ compile: [{ file: 'A.cs', line: 1, message: 'x' }] }), 0, opts),
    ).toBe(true);
    expect(shouldRepair(collected({ tests: [{ fullName: 't', message: 'm' }] }), 0, opts)).toBe(true);
  });

  it('respects the auto-repair setting, an abort and a dropped bridge', () => {
    expect(shouldRepair(withOne, 0, { ...opts, autoRepair: false })).toBe(false);
    expect(shouldRepair(withOne, 0, { ...opts, aborted: true })).toBe(false);
    expect(shouldRepair(withOne, 0, { ...opts, connected: false })).toBe(false);
  });

  it('may still run on the problems it did find during a reconnect', () => {
    const reconnected = collected({
      console: [problem()],
      consoleTotal: 1,
      degraded: 'reconnected',
    });
    expect(shouldRepair(reconnected, 0, opts)).toBe(true);
  });

  it('grants a bounded call budget to the pass', () => {
    expect(CONSOLE_REPAIR_CALL_GRANT).toBe(6);
  });
});

describe('repairTrigger', () => {
  it('names the single category that fired', () => {
    expect(repairTrigger(collected({ console: [problem()] }))).toBe('console');
    expect(repairTrigger(collected({ compile: [{ file: 'A', line: 1, message: 'm' }] }))).toBe(
      'compile',
    );
    expect(repairTrigger(collected({ tests: [{ fullName: 't', message: 'm' }] }))).toBe('tests');
  });

  it('is "mixed" when more than one fired, and null when none did', () => {
    expect(
      repairTrigger(collected({ console: [problem()], tests: [{ fullName: 't', message: 'm' }] })),
    ).toBe('mixed');
    expect(repairTrigger(collected())).toBeNull();
  });
});

describe('diffAfterRepair', () => {
  const item = (key: string, seq: number, external = false) =>
    problem({ key, firstLine: key, location: external ? null : 'Assets/A.cs:1', external, seq });
  const clean = { repairStartSeq: 20, secondCompileClean: true };

  it('counts a key that never came back as notReobserved, never as fixed', () => {
    const before = collected({ console: [item('a', 11)], consoleTotal: 1 });
    expect(diffAfterRepair(before, collected(), clean)).toEqual({
      fixed: 0,
      notReobserved: 1,
      remaining: 0,
    });
  });

  it('counts a key seen again AFTER the repair started as remaining', () => {
    const before = collected({ console: [item('a', 11)], consoleTotal: 1 });
    const after = collected({ console: [item('a', 25)], consoleTotal: 1 });
    expect(diffAfterRepair(before, after, clean)).toEqual({
      fixed: 0,
      notReobserved: 0,
      remaining: 1,
    });
  });

  it('does not call a key remaining when the only sighting predates the repair', () => {
    const before = collected({ console: [item('a', 11)], consoleTotal: 1 });
    // Same entry, still in the ring — its seq is older than the repair start.
    const after = collected({ console: [item('a', 11)], consoleTotal: 1 });
    expect(diffAfterRepair(before, after, clean)).toEqual({
      fixed: 0,
      notReobserved: 1,
      remaining: 0,
    });
  });

  it('ignores external problems entirely — they were never repaired', () => {
    const before = collected({ console: [item('e', 11, true)], consoleTotal: 1, externalTotal: 1 });
    expect(diffAfterRepair(before, collected(), clean)).toEqual({
      fixed: 0,
      notReobserved: 0,
      remaining: 0,
    });
  });

  it('counts compile errors as fixed only when the fresh report is CLEAN', () => {
    const before = collected({
      compile: [
        { file: 'A.cs', line: 1, message: 'x' },
        { file: 'B.cs', line: 2, message: 'y' },
      ],
    });
    expect(diffAfterRepair(before, collected(), clean).fixed).toBe(2);
    // Errors still in the fresh report: nothing was proven, and they stay counted.
    const stillBroken = diffAfterRepair(
      before,
      collected({ compile: [{ file: 'A.cs', line: 1, message: 'x' }] }),
      clean,
    );
    expect(stillBroken.fixed).toBe(0);
    expect(stillBroken.remaining).toBe(2);
  });

  // The regression. A second compile that was SKIPPED (no bridge, budget
  // exhausted, editor asleep) reports no errors for the same reason a clean one
  // does — and every compiler error was being called fixed on the strength of a
  // compile that never ran.
  it('never calls a compiler error fixed when the second compile did not produce a clean report', () => {
    const before = collected({ compile: [{ file: 'A.cs', line: 1, message: 'x' }] });
    const out = diffAfterRepair(before, collected(), {
      repairStartSeq: 20,
      secondCompileClean: false,
    });
    expect(out.fixed).toBe(0);
    expect(out.remaining).toBe(1);
  });

  it('adds unproven compiler errors to remaining alongside re-observed console errors', () => {
    const before = collected({
      console: [item('a', 11)],
      consoleTotal: 1,
      compile: [{ file: 'A.cs', line: 1, message: 'x' }],
    });
    const after = collected({ console: [item('a', 25)], consoleTotal: 1 });
    expect(
      diffAfterRepair(before, after, { repairStartSeq: 20, secondCompileClean: false }),
    ).toEqual({ fixed: 0, notReobserved: 0, remaining: 2 });
  });
});

describe('consoleResult', () => {
  const item = problem({ key: 'a', count: 2 });

  it('is "clean" only for a complete, empty read', () => {
    expect(consoleResult(collected(), null)).toBe('clean');
  });

  it('never reports a degraded empty read as clean', () => {
    expect(consoleResult(collected({ degraded: 'editor-asleep' }), null)).toEqual({
      unknown: 'editor-asleep',
    });
    expect(consoleResult(collected({ degraded: 'old-package' }), null)).toEqual({
      unknown: 'old-package',
    });
    expect(consoleResult(collected({ degraded: 'reconnected' }), null)).toEqual({
      unknown: 'reconnected',
    });
  });

  it('is unknown for a dropped bridge even when the ring still holds entries', () => {
    // With no connection there is no console to read, so nothing here is a verdict.
    expect(
      consoleResult(collected({ console: [item], consoleTotal: 1, degraded: 'no-bridge' }), null),
    ).toEqual({ unknown: 'no-bridge' });
  });

  it('reports the problems it found, with the items it carries', () => {
    expect(consoleResult(collected({ console: [item], consoleTotal: 1 }), null)).toEqual({
      newErrors: 1,
      external: 0,
      repaired: false,
      fixed: 0,
      notReobserved: 0,
      remaining: 0,
      streamOnly: false,
      items: [
        {
          logType: 'Exception',
          firstLine: 'boom',
          location: 'Assets/A.cs:1',
          count: 2,
          external: false,
        },
      ],
    });
  });

  it('folds the repair outcome in and marks the result as repaired', () => {
    const result = consoleResult(
      collected({ console: [item], consoleTotal: 1 }),
      { fixed: 2, notReobserved: 0, remaining: 1 },
      collected(),
    );
    expect(result).toMatchObject({ repaired: true, fixed: 2, remaining: 1 });
  });

  it('still reports a compile-only repair even though no console entry appeared', () => {
    const result = consoleResult(
      collected(),
      { fixed: 3, notReobserved: 0, remaining: 0 },
      collected(),
    );
    expect(result).toMatchObject({ newErrors: 0, repaired: true, fixed: 3 });
  });

  // The regression. An empty post-repair read means "we could not look", not
  // "it is gone" — and every item was falling through to notReobserved, which
  // rendered a degraded second read as a successful repair.
  it('never proves a repair off a DEGRADED re-read', () => {
    const before = collected({ console: [item], consoleTotal: 1 });
    for (const recheck of ['no-bridge', 'editor-asleep', 'reconnected', 'old-package'] as const) {
      expect(
        consoleResult(
          before,
          { fixed: 0, notReobserved: 1, remaining: 0 },
          collected({ degraded: recheck }),
        ),
      ).toEqual({ repairAttempted: true, recheck });
    }
  });

  it('still reports the diff when the SAME degradation was already there before the repair', () => {
    // Both halves read the same ring under the same conditions, so the
    // comparison between them still means something; only a NEW obstacle
    // invalidates it.
    expect(
      consoleResult(
        collected({ console: [item], consoleTotal: 1, degraded: 'reconnected' }),
        { fixed: 0, notReobserved: 1, remaining: 0 },
        collected({ degraded: 'reconnected' }),
      ),
    ).toMatchObject({ repaired: true, notReobserved: 1 });
  });

  it('reports a normal outcome when the re-read itself was fine', () => {
    expect(
      consoleResult(
        collected({ console: [item], consoleTotal: 1 }),
        { fixed: 0, notReobserved: 1, remaining: 0 },
        collected({ degraded: null }),
      ),
    ).toMatchObject({ repaired: true, notReobserved: 1 });
  });

  it('carries the stream-only flag through so the row can keep saying so', () => {
    expect(
      consoleResult(collected({ console: [item], consoleTotal: 1, streamOnly: true }), null),
    ).toMatchObject({ streamOnly: true });
  });
});

describe('testsResult', () => {
  it('is skipped when no run was recorded this send', () => {
    expect(testsResult(null)).toBe('skipped');
  });

  it('reads the latest recorded run, defaulting absent counts to zero', () => {
    expect(
      testsResult({ mode: 'PlayMode', passed: 12, failed: 2, failures: [{ fullName: 'a', message: 'm' }] }),
    ).toEqual({
      mode: 'PlayMode',
      passed: 12,
      failed: 2,
      skipped: 0,
      failures: [{ fullName: 'a', message: 'm' }],
    });
  });
});

describe('the repair prompt inputs', () => {
  const own = problem({
    key: 'a',
    frames: [
      { className: 'A', methodName: 'M', filePath: 'Assets/A.cs', lineNumber: 1 },
      { className: 'A', methodName: 'N', filePath: 'Assets/B.cs', lineNumber: 2 },
    ],
  });
  const external = problem({ key: 'e', external: true, location: null });

  it('lists every problem, external ones included, so the model can see the whole picture', () => {
    const problems = repairPromptProblems(collected({ console: [own, external] }));
    expect(problems.map((p) => p.external)).toEqual([false, true]);
  });

  it('only embeds code regions for problems inside this project', () => {
    expect(repairPromptFrames(collected({ console: [own, external] })).map((f) => f.filePath)).toEqual(
      ['Assets/A.cs', 'Assets/B.cs'],
    );
  });
});

describe('the system notices', () => {
  const own = problem({ key: 'a' });

  it('names console errors and failed tests as things that appeared during the turn', () => {
    expect(
      repairNotice(
        collected({
          console: [own, problem({ key: 'b' })],
          consoleTotal: 2,
          tests: [{ fullName: 't', message: 'm' }],
        }),
      ),
    ).toBe(
      'Console check — 2 new errors and 1 failed test appeared during this turn; asking the AI to fix them (one pass).',
    );
  });

  it('says compiler errors REMAIN after the turn when they are the only trigger', () => {
    expect(
      repairNotice(
        collected({
          compile: [
            { file: 'A', line: 1, message: 'x' },
            { file: 'B', line: 2, message: 'y' },
            { file: 'C', line: 3, message: 'z' },
          ],
        }),
      ),
    ).toBe(
      'Console check — 3 compiler errors remain after this turn; asking the AI to fix them (one pass).',
    );
  });

  it('joins three categories with commas and a final "and"', () => {
    expect(
      repairNotice(
        collected({
          console: [own],
          consoleTotal: 1,
          compile: [{ file: 'A', line: 1, message: 'x' }],
          tests: [{ fullName: 't', message: 'm' }],
        }),
      ),
    ).toBe(
      'Console check — 1 new error, 1 compiler error and 1 failed test appeared during this turn; asking the AI to fix them (one pass).',
    );
  });

  it('has a distinct notice for the case where nothing is this project\'s to fix', () => {
    const externalOnly = collected({
      console: [problem({ external: true, location: null })],
      consoleTotal: 1,
      externalTotal: 1,
    });
    expect(isExternalOnly(externalOnly)).toBe(true);
    expect(EXTERNAL_ONLY_NOTICE).toBe(
      'Console check — new errors came from packages or the engine, not this project; nothing to fix automatically.',
    );
  });

  it('is not "external only" when there is anything else to repair', () => {
    expect(
      isExternalOnly(
        collected({
          console: [problem({ external: true, location: null })],
          consoleTotal: 1,
          externalTotal: 1,
          compile: [{ file: 'A', line: 1, message: 'x' }],
        }),
      ),
    ).toBe(false);
    expect(isExternalOnly(collected())).toBe(false);
  });
});

describe('the card rows', () => {
  const result = (
    over: Partial<{
      newErrors: number;
      external: number;
      repaired: boolean;
      fixed: number;
      notReobserved: number;
      remaining: number;
      streamOnly: boolean;
    }> = {},
  ) => ({
    newErrors: 1,
    external: 0,
    repaired: false,
    fixed: 0,
    notReobserved: 0,
    remaining: 0,
    streamOnly: false,
    items: [],
    ...over,
  });

  it('reads "console clean" only for a complete, empty read', () => {
    expect(consoleRowLabel('clean')).toBe('console clean');
  });

  it('names every degraded state instead of implying a clean console', () => {
    expect(consoleRowLabel({ unknown: 'no-bridge' })).toBe('console (no Unity bridge)');
    expect(consoleRowLabel({ unknown: 'editor-asleep' })).toBe(
      'console unknown (Unity in background)',
    );
    expect(consoleRowLabel({ unknown: 'reconnected' })).toBe(
      'console unknown (Unity reconnected mid-turn — history may be incomplete)',
    );
    expect(consoleRowLabel({ unknown: 'old-package' })).toBe(
      'console: stream only (update the bridge package for full history)',
    );
  });

  it('counts new errors when no repair ran', () => {
    expect(consoleRowLabel(result({ newErrors: 2 }))).toBe('console: 2 new errors');
    expect(consoleRowLabel(result({ newErrors: 1 }))).toBe('console: 1 new error');
  });

  it('reports what the repair proved and what came back', () => {
    expect(consoleRowLabel(result({ newErrors: 3, repaired: true, fixed: 2, remaining: 1 }))).toBe(
      'console: 2 fixed, 1 remaining',
    );
  });

  it('never claims a console error is fixed — only that it was not seen again', () => {
    expect(consoleRowLabel(result({ newErrors: 1, repaired: true, notReobserved: 1 }))).toBe(
      'console: 1 not seen again (needs Play Mode to confirm)',
    );
  });

  it('says plainly that a repair was attempted but could not be re-checked', () => {
    expect(consoleRowLabel({ repairAttempted: true, recheck: 'editor-asleep' })).toBe(
      'console: repair attempted, re-check unavailable (Unity in background)',
    );
    expect(consoleRowLabel({ repairAttempted: true, recheck: 'no-bridge' })).toBe(
      'console: repair attempted, re-check unavailable (no Unity bridge)',
    );
    expect(consoleRowLabel({ repairAttempted: true, recheck: 'reconnected' })).toBe(
      'console: repair attempted, re-check unavailable (Unity reconnected mid-turn)',
    );
    expect(consoleRowLabel({ repairAttempted: true, recheck: 'old-package' })).toBe(
      'console: repair attempted, re-check unavailable (stream only — update the bridge package for full history)',
    );
  });

  // The caveat is not only about finding nothing: it is that nobody knows how
  // much MORE there was before this session started listening.
  it('keeps the stream-only caveat visible even when problems were found', () => {
    expect(consoleRowLabel(result({ newErrors: 2, streamOnly: true }))).toBe(
      'console: 2 new errors (stream only — update the bridge package for full history)',
    );
    expect(
      consoleRowLabel(result({ newErrors: 2, repaired: true, fixed: 1, remaining: 1, streamOnly: true })),
    ).toBe('console: 1 fixed, 1 remaining (stream only — update the bridge package for full history)');
  });

  it('reads the test counts off the latest run', () => {
    expect(
      testsRowLabel({ mode: 'EditMode', passed: 12, failed: 0, skipped: 0, failures: [] }),
    ).toBe('tests: 12 passed');
    expect(
      testsRowLabel({ mode: 'EditMode', passed: 12, failed: 2, skipped: 0, failures: [] }),
    ).toBe('tests: 2 of 14 failed');
  });
});
