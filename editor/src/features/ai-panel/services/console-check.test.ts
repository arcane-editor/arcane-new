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
  type CollectInput,
  type CollectedProblems,
  type ConsoleCheckBaseline,
  type ConsoleEntryInput,
} from './console-check';

const BASE: ConsoleCheckBaseline = {
  seq: 10,
  epoch: 1,
  startedAt: 1_000,
  compileIdentity: null,
  editorAwake: true,
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
    epoch: BASE.epoch,
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
    snapshot: 'not-attempted',
    ...overrides,
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
      BASE.epoch,
    );
    expect(kept.map((e) => e.seq)).toEqual([11]);
  });

  it('takes everything still in the ring when the console was cleared mid-turn (epoch moved)', () => {
    // After a clear the ring is emptied, so whatever is in it is post-clear —
    // and the baseline seq no longer describes anything.
    const kept = selectNewEntries([entry({ seq: 1 }), entry({ seq: 2 })], BASE, BASE.epoch + 1);
    expect(kept).toHaveLength(2);
  });

  it('drops entries backfilled from Unity\'s own console history', () => {
    const kept = selectNewEntries([entry({ seq: 11, historical: true })], BASE, BASE.epoch);
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
      BASE.epoch,
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
      BASE.epoch,
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
        snapshot: [entry({ seq: null, count: 9 })],
        snapshotStatus: 'used',
      }),
    );
    expect(out.console).toHaveLength(1);
    expect(out.console[0].count).toBe(9);
    expect(out.snapshot).toBe('used');
  });

  it('never adopts a snapshot-only key — a snapshot row carries no proof it is from this turn', () => {
    const out = collectNewProblems(
      input({
        ring: [],
        snapshot: [entry({ seq: null, message: 'An error from an hour ago' })],
        snapshotStatus: 'used',
      }),
    );
    expect(out.console).toHaveLength(0);
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
  const withOne = collected({ console: [oneOwn()], consoleTotal: 1 });

  function oneOwn() {
    return {
      key: 'k',
      logType: 'Exception' as const,
      firstLine: 'boom',
      location: 'Assets/A.cs:1',
      count: 1,
      external: false,
      seq: 11,
      frames: [],
    };
  }

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
      console: [{ ...oneOwn(), external: true, location: null }],
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

  it('grants a bounded call budget to the pass', () => {
    expect(CONSOLE_REPAIR_CALL_GRANT).toBe(6);
  });
});

describe('repairTrigger', () => {
  const own = {
    key: 'k',
    logType: 'Exception' as const,
    firstLine: 'boom',
    location: 'Assets/A.cs:1',
    count: 1,
    external: false,
    seq: 11,
    frames: [],
  };

  it('names the single category that fired', () => {
    expect(repairTrigger(collected({ console: [own] }))).toBe('console');
    expect(repairTrigger(collected({ compile: [{ file: 'A', line: 1, message: 'm' }] }))).toBe(
      'compile',
    );
    expect(repairTrigger(collected({ tests: [{ fullName: 't', message: 'm' }] }))).toBe('tests');
  });

  it('is "mixed" when more than one fired, and null when none did', () => {
    expect(
      repairTrigger(collected({ console: [own], tests: [{ fullName: 't', message: 'm' }] })),
    ).toBe('mixed');
    expect(repairTrigger(collected())).toBeNull();
  });
});

describe('diffAfterRepair', () => {
  const item = (key: string, seq: number, external = false) => ({
    key,
    logType: 'Exception' as const,
    firstLine: key,
    location: external ? null : 'Assets/A.cs:1',
    count: 1,
    external,
    seq,
    frames: [],
  });

  it('counts a key that never came back as notReobserved, never as fixed', () => {
    const before = collected({ console: [item('a', 11)], consoleTotal: 1 });
    const out = diffAfterRepair(before, collected(), 20);
    expect(out).toEqual({ fixed: 0, notReobserved: 1, remaining: 0 });
  });

  it('counts a key seen again AFTER the repair started as remaining', () => {
    const before = collected({ console: [item('a', 11)], consoleTotal: 1 });
    const after = collected({ console: [item('a', 25)], consoleTotal: 1 });
    expect(diffAfterRepair(before, after, 20)).toEqual({
      fixed: 0,
      notReobserved: 0,
      remaining: 1,
    });
  });

  it('does not call a key remaining when the only sighting predates the repair', () => {
    const before = collected({ console: [item('a', 11)], consoleTotal: 1 });
    // Same entry, still in the ring — its seq is older than the repair start.
    const after = collected({ console: [item('a', 11)], consoleTotal: 1 });
    expect(diffAfterRepair(before, after, 20)).toEqual({
      fixed: 0,
      notReobserved: 1,
      remaining: 0,
    });
  });

  it('ignores external problems entirely — they were never repaired', () => {
    const before = collected({ console: [item('e', 11, true)], consoleTotal: 1, externalTotal: 1 });
    expect(diffAfterRepair(before, collected(), 20)).toEqual({
      fixed: 0,
      notReobserved: 0,
      remaining: 0,
    });
  });

  it('counts compile errors as fixed only when the FRESH report is clean', () => {
    const before = collected({
      compile: [
        { file: 'A.cs', line: 1, message: 'x' },
        { file: 'B.cs', line: 2, message: 'y' },
      ],
    });
    expect(diffAfterRepair(before, collected(), 20).fixed).toBe(2);
    expect(
      diffAfterRepair(before, collected({ compile: [{ file: 'A.cs', line: 1, message: 'x' }] }), 20)
        .fixed,
    ).toBe(0);
  });
});

describe('consoleResult', () => {
  const item = {
    key: 'a',
    logType: 'Exception' as const,
    firstLine: 'boom',
    location: 'Assets/A.cs:1',
    count: 2,
    external: false,
    seq: 11,
    frames: [],
  };

  it('is "clean" only when the read was complete and found nothing', () => {
    expect(consoleResult(collected(), null)).toBe('clean');
  });

  it('never reports a degraded empty read as clean', () => {
    expect(consoleResult(collected({ degraded: 'editor-asleep' }), null)).toEqual({
      unknown: 'editor-asleep',
    });
    expect(consoleResult(collected({ degraded: 'old-package' }), null)).toEqual({
      unknown: 'old-package',
    });
  });

  it('is unknown for a dropped bridge even when the ring still holds entries', () => {
    // With no connection there is no console to read, so nothing here is a verdict.
    expect(
      consoleResult(collected({ console: [item], consoleTotal: 1, degraded: 'no-bridge' }), null),
    ).toEqual({ unknown: 'no-bridge' });
  });

  it('reports the problems it found, with the items it carries', () => {
    const result = consoleResult(collected({ console: [item], consoleTotal: 1 }), null);
    expect(result).toEqual({
      newErrors: 1,
      external: 0,
      repaired: false,
      fixed: 0,
      notReobserved: 0,
      remaining: 0,
      items: [{ logType: 'Exception', firstLine: 'boom', location: 'Assets/A.cs:1', count: 2 }],
    });
  });

  it('folds the repair outcome in and marks the result as repaired', () => {
    const result = consoleResult(collected({ console: [item], consoleTotal: 1 }), {
      fixed: 2,
      notReobserved: 0,
      remaining: 1,
    });
    expect(result).toMatchObject({ repaired: true, fixed: 2, remaining: 1 });
  });

  it('still reports a compile-only repair even though no console entry appeared', () => {
    const result = consoleResult(collected(), { fixed: 3, notReobserved: 0, remaining: 0 });
    expect(result).toMatchObject({ newErrors: 0, repaired: true, fixed: 3 });
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
  const own = {
    key: 'a',
    logType: 'Exception' as const,
    firstLine: 'boom',
    location: 'Assets/A.cs:1',
    count: 1,
    external: false,
    seq: 11,
    frames: [
      { className: 'A', methodName: 'M', filePath: 'Assets/A.cs', lineNumber: 1 },
      { className: 'A', methodName: 'N', filePath: 'Assets/B.cs', lineNumber: 2 },
    ],
  };
  const external = { ...own, key: 'e', external: true, location: null, frames: [] };

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
  const own = {
    key: 'a',
    logType: 'Exception' as const,
    firstLine: 'boom',
    location: 'Assets/A.cs:1',
    count: 1,
    external: false,
    seq: 11,
    frames: [],
  };

  it('names console errors and failed tests as things that appeared during the turn', () => {
    expect(
      repairNotice(
        collected({
          console: [own, { ...own, key: 'b' }],
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
      console: [{ ...own, external: true, location: null }],
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
          console: [{ ...own, external: true, location: null }],
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
    }> = {},
  ) => ({
    newErrors: 1,
    external: 0,
    repaired: false,
    fixed: 0,
    notReobserved: 0,
    remaining: 0,
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

  it('reads the test counts off the latest run', () => {
    expect(
      testsRowLabel({ mode: 'EditMode', passed: 12, failed: 0, skipped: 0, failures: [] }),
    ).toBe('tests: 12 passed');
    expect(
      testsRowLabel({ mode: 'EditMode', passed: 12, failed: 2, skipped: 0, failures: [] }),
    ).toBe('tests: 2 of 14 failed');
  });
});
