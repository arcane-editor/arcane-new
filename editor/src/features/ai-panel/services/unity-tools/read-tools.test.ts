// `read-tools.ts` cannot take `useUnityStore`/`bridgeRpc`/`useUnityIndexStore`
// as a static value import — all three transitively reach `document` — so
// `get_console_errors` and `get_compile_errors` take their store/bridge access
// through an injected `deps` object (`ConsoleToolDeps` / `CompileErrorsToolDeps`),
// mirroring `compile-gate.ts`'s `CompileGateDeps` seam. These tests exercise
// the tools directly through fake deps — the same pattern `compile-gate.test.ts`
// uses for `CompileGateDeps`.

import { describe, it, expect } from 'bun:test';
import {
  createGetConsoleErrors,
  createGetCompileErrors,
  markConsoleTurnStart,
  collapseConsoleEntries,
  renderConsoleErrors,
  formatCompileAge,
  type ConsoleToolDeps,
  type CompileErrorsToolDeps,
  type ConsoleDisplayEntry,
} from './read-tools';
import type { HintLookup } from './compile-hints';
import type { AgentToolResult } from '../vendor/types';
import type { CompileWaitOutcome } from '../../../unity-bridge';
import type { CompilationPayload, ConsoleSnapshot, UnityLogEntry } from '../../../../types/unity';

const idleClient: HintLookup = {
  lookup: async () => ({ ok: true, data: [] }),
  search: async () => ({ ok: true, data: [] }),
};

/** Unity's real "(at File.cs:line)" shape — the only thing `parseStackTrace` recognizes. */
function frameLine(className: string, method: string, file: string, line: number): string {
  return `${className}.${method} () (at ${file}:${line})`;
}

function textOf(res: AgentToolResult): string {
  return res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
}

function logEntry(over: Partial<UnityLogEntry> = {}): UnityLogEntry {
  return {
    message: 'boom',
    stackTrace: '',
    logType: 'Error',
    timestamp: 0,
    frameCount: 0,
    mode: 'EditMode',
    ...over,
  };
}

function snapshot(over: Partial<ConsoleSnapshot> = {}): ConsoleSnapshot {
  return {
    source: 'logEntries',
    epoch: 0,
    total: 0,
    offset: 0,
    counts: { errors: 0, warnings: 0, logs: 0 },
    entries: [],
    truncated: false,
    capabilities: { canClear: true, hasHistoryBeforeConnect: true },
    ...over,
  };
}

function consoleDeps(over: Partial<ConsoleToolDeps> = {}): ConsoleToolDeps {
  return {
    unitySnap: async () => ({ connected: false, bridgeProtocol: null, logs: [] }),
    getConsoleSnapshot: async () => snapshot(),
    ...over,
  };
}

describe('get_console_errors — source fallback labels', () => {
  it('bridge not connected: falls back to the session ring with the exact label', async () => {
    const tool = createGetConsoleErrors(
      consoleDeps({
        unitySnap: async () => ({ connected: false, bridgeProtocol: null, logs: [logEntry()] }),
      }),
    );
    const res = await tool.execute('id', {}, undefined, undefined);
    const text = textOf(res);
    expect(text).toContain(
      "Unity's console history is unavailable: bridge not connected — showing what streamed to this IDE this session.",
    );
    expect(text).toContain('(source: this session)');
  });

  it('connected but pre-protocol-4 (protocol known): falls back with the exact "predates" label', async () => {
    const tool = createGetConsoleErrors(
      consoleDeps({
        unitySnap: async () => ({ connected: true, bridgeProtocol: 3, logs: [logEntry()] }),
      }),
    );
    const res = await tool.execute('id', {}, undefined, undefined);
    const text = textOf(res);
    expect(text).toContain(
      "Unity's console history is unavailable: the installed bridge package predates protocol 4 — update it",
    );
  });

  it('connected but protocol UNKNOWN (null): does not claim "predates protocol 4"', async () => {
    // I1: only claim the version fact when it is actually known — a null
    // protocol while connected (the late-attach race) must get an honestly
    // different label, not a guess dressed up as a fact.
    const tool = createGetConsoleErrors(
      consoleDeps({
        unitySnap: async () => ({ connected: true, bridgeProtocol: null, logs: [logEntry()] }),
      }),
    );
    const res = await tool.execute('id', {}, undefined, undefined);
    const text = textOf(res);
    expect(text).not.toContain('predates protocol 4');
    expect(text).toContain("Unity's console history is unavailable");
    expect(text).toContain("protocol version isn't known yet");
  });

  it('connected + protocol 4: reads via the RPC, no degraded note, source label is "Unity console", prints parsed frames', async () => {
    let called = false;
    const tool = createGetConsoleErrors(
      consoleDeps({
        unitySnap: async () => ({ connected: true, bridgeProtocol: 4, logs: [] }),
        getConsoleSnapshot: async (opts) => {
          called = true;
          expect(opts.limit).toBe(50);
          return snapshot({
            source: 'logEntries',
            total: 1,
            counts: { errors: 1, warnings: 0, logs: 0 },
            entries: [
              {
                seq: 1,
                logType: 'Error',
                message: 'boom',
                stackTrace: frameLine('Foo', 'Bar', 'Assets/Foo.cs', 3),
                file: 'Assets/Foo.cs',
                line: 3,
                mode: 'Unknown',
                count: 1,
              },
            ],
          });
        },
      }),
    );
    const res = await tool.execute('id', {}, undefined, undefined);
    const text = textOf(res);
    expect(called).toBe(true);
    expect(text).toContain('Unity console: 1 errors, 0 warnings, 0 logs (source: Unity console)');
    expect(text).not.toContain('unavailable');
    expect(text).toContain('Assets/Foo.cs:3');
    expect(text).toContain('Showing 1 of 1 entries (page 0)');
  });

  it('RPC source hookRing: labels the degraded read honestly', async () => {
    const tool = createGetConsoleErrors(
      consoleDeps({
        unitySnap: async () => ({ connected: true, bridgeProtocol: 4, logs: [] }),
        getConsoleSnapshot: async () =>
          snapshot({
            source: 'hookRing',
            counts: { errors: 1, warnings: 0, logs: 0 },
            entries: [{ seq: 1, logType: 'Error', message: 'boom', stackTrace: '', file: '', line: 0, mode: 'EditMode', count: 1 }],
          }),
      }),
    );
    const res = await tool.execute('id', {}, undefined, undefined);
    const text = textOf(res);
    expect(text).toContain("Unity's own console API is unavailable on this Editor version");
    // M10: the header used to say plain "Unity console" for an answer that
    // never touched Unity's console — the source label now names what was
    // actually read.
    expect(text).toContain('(source: Unity console (bridge ring))');
  });

  it('RPC call throws (Unity backgrounded / worker timeout): a label distinct from "predates protocol 4"', async () => {
    // I1: getConsoleSnapshot is a blocking RPC that fails when Unity's main
    // thread is parked in the background — that must not be blamed on the
    // package version.
    const tool = createGetConsoleErrors(
      consoleDeps({
        unitySnap: async () => ({ connected: true, bridgeProtocol: 4, logs: [logEntry({ message: 'session fallback' })] }),
        getConsoleSnapshot: async () => {
          throw new Error('RPC timed out');
        },
      }),
    );
    const res = await tool.execute('id', {}, undefined, undefined);
    const text = textOf(res);
    expect(text).toContain(
      "Unity's console history is unavailable: the request to Unity failed or timed out — Unity may be in the background.",
    );
    expect(text).not.toContain('predates protocol 4');
    expect(text).toContain('session fallback');
  });

  it('explicit source:"session" skips the RPC even when connected + protocol 4', async () => {
    let rpcCalled = false;
    const tool = createGetConsoleErrors(
      consoleDeps({
        unitySnap: async () => ({ connected: true, bridgeProtocol: 4, logs: [logEntry({ message: 'from session' })] }),
        getConsoleSnapshot: async () => {
          rpcCalled = true;
          return snapshot();
        },
      }),
    );
    const res = await tool.execute('id', { source: 'session' }, undefined, undefined);
    expect(rpcCalled).toBe(false);
    expect(textOf(res)).toContain('(source: this session)');
    // Asked for explicitly — not a degraded fallback, so no "unavailable" note.
    expect(textOf(res)).not.toContain('unavailable');
  });
});

describe('get_console_errors — includeStackTrace', () => {
  const withFrame = {
    seq: 1,
    logType: 'Error' as const,
    message: 'boom',
    stackTrace: frameLine('Foo', 'Bar', 'Assets/Foo.cs', 3),
    file: 'Assets/Foo.cs',
    line: 3,
    mode: 'Unknown' as const,
    count: 1,
  };

  it('default (true): prints up to 4 parsed frames per entry', async () => {
    const tool = createGetConsoleErrors(
      consoleDeps({
        unitySnap: async () => ({ connected: true, bridgeProtocol: 4, logs: [] }),
        getConsoleSnapshot: async () => snapshot({ counts: { errors: 1, warnings: 0, logs: 0 }, entries: [withFrame] }),
      }),
    );
    const res = await tool.execute('id', {}, undefined, undefined);
    expect(textOf(res)).toContain('at Foo.Bar (Assets/Foo.cs:3)');
  });

  it('includeStackTrace:false omits frames', async () => {
    const tool = createGetConsoleErrors(
      consoleDeps({
        unitySnap: async () => ({ connected: true, bridgeProtocol: 4, logs: [] }),
        getConsoleSnapshot: async () => snapshot({ counts: { errors: 1, warnings: 0, logs: 0 }, entries: [withFrame] }),
      }),
    );
    const res = await tool.execute('id', { includeStackTrace: false }, undefined, undefined);
    expect(textOf(res)).not.toContain('at Foo.Bar');
  });

  it('caps at 4 frames on the session ring path too', async () => {
    const frames = [1, 2, 3, 4, 5].map((n) => frameLine('Foo', `M${n}`, 'Assets/Foo.cs', n)).join('\n');
    const tool = createGetConsoleErrors(
      consoleDeps({
        unitySnap: async () => ({ connected: false, bridgeProtocol: null, logs: [logEntry({ stackTrace: frames })] }),
      }),
    );
    const res = await tool.execute('id', {}, undefined, undefined);
    const text = textOf(res);
    expect(text).toContain('M1');
    expect(text).toContain('M4');
    expect(text).not.toContain('M5');
  });
});

describe('get_console_errors — collapse counts', () => {
  it('collapseConsoleEntries merges consecutive identical logType+firstLine+frame', () => {
    const entries: ConsoleDisplayEntry[] = [
      { logType: 'Error', message: 'boom', file: 'Assets/Foo.cs', line: 3 },
      { logType: 'Error', message: 'boom', file: 'Assets/Foo.cs', line: 3 },
      { logType: 'Error', message: 'boom', file: 'Assets/Foo.cs', line: 3 },
      { logType: 'Warning', message: 'careful', file: 'Assets/Bar.cs', line: 9 },
    ];
    const collapsed = collapseConsoleEntries(entries);
    expect(collapsed).toHaveLength(2);
    expect(collapsed[0]!.count).toBe(3);
    expect(collapsed[1]!.count).toBe(1);
  });

  it('does not collapse entries with different first lines', () => {
    const entries: ConsoleDisplayEntry[] = [
      { logType: 'Error', message: 'boom one' },
      { logType: 'Error', message: 'boom two' },
    ];
    expect(collapseConsoleEntries(entries)).toHaveLength(2);
  });

  it('renderConsoleErrors prints ×N for a collapsed run', () => {
    const entries: ConsoleDisplayEntry[] = [
      { logType: 'Error', message: 'boom' },
      { logType: 'Error', message: 'boom' },
      { logType: 'Error', message: 'boom' },
    ];
    const text = renderConsoleErrors(entries, { errors: 3, warnings: 0, logs: 0 }, 'this session', '', true, {
      total: 3,
      page: 0,
      limit: 50,
      truncated: false,
    });
    expect(text).toContain('×3');
  });

  it('a single (uncollapsed) entry never shows a ×N suffix', () => {
    const text = renderConsoleErrors(
      [{ logType: 'Error', message: 'boom' }],
      { errors: 1, warnings: 0, logs: 0 },
      'this session',
      '',
      true,
      { total: 1, page: 0, limit: 50, truncated: false },
    );
    expect(text).not.toContain('×');
  });
});

describe('get_console_errors — paging trailer (truncated/total)', () => {
  it('surfaces "Showing N of M entries (page P)" and flags more when truncated', () => {
    const text = renderConsoleErrors(
      [{ logType: 'Error', message: 'boom' }],
      { errors: 312, warnings: 0, logs: 0 },
      'this session',
      '',
      true,
      { total: 312, page: 0, limit: 50, truncated: true },
    );
    expect(text).toContain('Showing 1 of 312 entries (page 0)');
    expect(text).toContain('more available');
  });

  it('an empty page still reports the total when one exists', () => {
    const text = renderConsoleErrors([], { errors: 5, warnings: 0, logs: 0 }, 'this session', '', true, {
      total: 5,
      page: 3,
      limit: 50,
      truncated: false,
    });
    expect(text).toContain('5 total across all pages');
  });
});

describe('get_console_errors — sinceTurnStart always answers from the session ring', () => {
  it('excludes session-ring entries at or before the turn-start baseline', async () => {
    markConsoleTurnStart(5);
    const tool = createGetConsoleErrors(
      consoleDeps({
        unitySnap: async () => ({
          connected: false,
          bridgeProtocol: null,
          logs: [
            logEntry({ seq: 3, message: 'old' }),
            logEntry({ seq: 5, message: 'at-boundary' }),
            logEntry({ seq: 6, message: 'new' }),
          ],
        }),
      }),
    );
    const res = await tool.execute('id', { sinceTurnStart: true }, undefined, undefined);
    const text = textOf(res);
    expect(text).toContain('new');
    expect(text).not.toContain('old');
    expect(text).not.toContain('at-boundary');
    markConsoleTurnStart(0);
  });

  it('without sinceTurnStart, older entries are still included', async () => {
    markConsoleTurnStart(5);
    const tool = createGetConsoleErrors(
      consoleDeps({
        unitySnap: async () => ({
          connected: false,
          bridgeProtocol: null,
          logs: [logEntry({ seq: 3, message: 'old' }), logEntry({ seq: 6, message: 'new' })],
        }),
      }),
    );
    const res = await tool.execute('id', {}, undefined, undefined);
    expect(textOf(res)).toContain('old');
    markConsoleTurnStart(0);
  });

  it('I3: even when connected + protocol 4 (source defaults to "unity"), sinceTurnStart reads the SESSION ring, not the RPC', async () => {
    let rpcCalled = false;
    markConsoleTurnStart(5);
    const tool = createGetConsoleErrors(
      consoleDeps({
        unitySnap: async () => ({
          connected: true,
          bridgeProtocol: 4,
          logs: [logEntry({ seq: 3, message: 'old-session' }), logEntry({ seq: 6, message: 'new-session' })],
        }),
        getConsoleSnapshot: async () => {
          rpcCalled = true;
          return snapshot();
        },
      }),
    );
    const res = await tool.execute('id', { sinceTurnStart: true }, undefined, undefined);
    const text = textOf(res);
    expect(rpcCalled).toBe(false);
    expect(text).toContain('new-session');
    expect(text).not.toContain('old-session');
    expect(text).toContain('(source: this session)');
    expect(text).toContain("since-turn-start uses this session's stream");
    markConsoleTurnStart(0);
  });

  it('sinceTurnStart with an explicit source:"session" gets no extra note (nothing degraded about it)', async () => {
    markConsoleTurnStart(0);
    const tool = createGetConsoleErrors(
      consoleDeps({
        unitySnap: async () => ({ connected: true, bridgeProtocol: 4, logs: [logEntry({ seq: 1, message: 'x' })] }),
      }),
    );
    const res = await tool.execute('id', { sinceTurnStart: true, source: 'session' }, undefined, undefined);
    expect(textOf(res)).not.toContain('since-turn-start uses');
  });
});

describe('get_console_errors — severity', () => {
  it('default severity ("error") excludes plain Log/Warning entries', async () => {
    const tool = createGetConsoleErrors(
      consoleDeps({
        unitySnap: async () => ({
          connected: false,
          bridgeProtocol: null,
          logs: [
            logEntry({ logType: 'Log', message: 'just a log' }),
            logEntry({ logType: 'Warning', message: 'just a warning' }),
            logEntry({ logType: 'Error', message: 'a real error' }),
          ],
        }),
      }),
    );
    const res = await tool.execute('id', {}, undefined, undefined);
    const text = textOf(res);
    expect(text).toContain('a real error');
    expect(text).not.toContain('just a log');
    expect(text).not.toContain('just a warning');
  });

  it('severity:"all" includes everything', async () => {
    const tool = createGetConsoleErrors(
      consoleDeps({
        unitySnap: async () => ({
          connected: false,
          bridgeProtocol: null,
          logs: [logEntry({ logType: 'Log', message: 'just a log' })],
        }),
      }),
    );
    const res = await tool.execute('id', { severity: 'all' }, undefined, undefined);
    expect(textOf(res)).toContain('just a log');
  });
});

// ── get_compile_errors ───────────────────────────────────────────────────────

function compileDeps(over: Partial<CompileErrorsToolDeps> = {}): CompileErrorsToolDeps {
  return {
    lastCompilation: async () => null,
    recompile: async () => ({ status: 'no-compile' }),
    ...over,
  };
}

describe('formatCompileAge', () => {
  it('renders seconds, minutes, and hours', () => {
    const now = 1_000_000;
    expect(formatCompileAge(now - 500, now)).toBe('just now');
    expect(formatCompileAge(now - 45_000, now)).toBe('45 seconds ago');
    expect(formatCompileAge(now - 2 * 60_000, now)).toBe('2 minutes ago');
    expect(formatCompileAge(now - 60_000, now)).toBe('1 minute ago');
    expect(formatCompileAge(now - 3 * 60 * 60_000, now)).toBe('3 hours ago');
  });
});

describe('get_compile_errors', () => {
  it('recompile:false with no prior compile: says so plainly, no engine round-trip', async () => {
    let recompileCalled = false;
    const tool = createGetCompileErrors(
      idleClient,
      compileDeps({ recompile: async () => { recompileCalled = true; return { status: 'no-compile' }; } }),
    );
    const res = await tool.execute('id', {}, undefined, undefined);
    expect(recompileCalled).toBe(false);
    expect(textOf(res)).toContain('No compile report this session');
  });

  it('recompile:false with a prior clean compile reports its age (S1)', async () => {
    const clean: CompilationPayload = {
      started: false,
      success: true,
      errors: 0,
      warnings: 0,
      messages: [],
      receivedAt: Date.now() - 2 * 60_000,
    };
    const tool = createGetCompileErrors(idleClient, compileDeps({ lastCompilation: async () => clean }));
    const res = await tool.execute('id', {}, undefined, undefined);
    const text = textOf(res);
    expect(text).toContain('Clean — no compiler errors.');
    expect(text).toMatch(/Last compile report: 2 minutes ago \(0 errors\)/);
  });

  it('reports "unknown time" when receivedAt is absent', async () => {
    const clean: CompilationPayload = { started: false, success: true, errors: 0, warnings: 0, messages: [] };
    const tool = createGetCompileErrors(idleClient, compileDeps({ lastCompilation: async () => clean }));
    const res = await tool.execute('id', {}, undefined, undefined);
    expect(textOf(res)).toContain('Last compile report: unknown time (0 errors)');
  });

  it('recompile:false with a prior error report: lists file:line: message and the error count/age', async () => {
    const report: CompilationPayload = {
      started: false,
      success: false,
      errors: 1,
      warnings: 0,
      messages: [{ file: 'Assets/Foo.cs', line: 5, column: 1, message: "CS1061: no 'Fly'", type: 'Error' }],
      receivedAt: Date.now() - 5_000,
    };
    const tool = createGetCompileErrors(idleClient, compileDeps({ lastCompilation: async () => report }));
    const res = await tool.execute('id', {}, undefined, undefined);
    const text = textOf(res);
    expect(text).toContain('1 compiler error(s)');
    expect(text).toContain('Assets/Foo.cs:5:');
    expect(text).toContain('Last compile report:');
    expect(text).toContain('(1 error)');
  });

  it('does not start with the [Unity compile] marker', async () => {
    const report: CompilationPayload = {
      started: false,
      errors: 1,
      warnings: 0,
      messages: [{ file: 'Assets/Foo.cs', line: 5, column: 1, message: 'boom', type: 'Error' }],
    };
    const tool = createGetCompileErrors(idleClient, compileDeps({ lastCompilation: async () => report }));
    const res = await tool.execute('id', {}, undefined, undefined);
    expect(textOf(res)).not.toContain('[Unity compile]');
  });

  const outcomeCases: Array<{ name: string; outcome: CompileWaitOutcome; expect: (text: string) => void }> = [
    {
      name: 'report with errors',
      outcome: {
        status: 'report',
        report: {
          started: false,
          errors: 1,
          warnings: 0,
          messages: [{ file: 'Assets/Foo.cs', line: 2, column: 1, message: 'boom', type: 'Error' }],
        },
      },
      expect: (t) => {
        expect(t).toContain('1 compiler error(s)');
        expect(t).toContain('Assets/Foo.cs:2:');
      },
    },
    {
      name: 'report with zero errors',
      outcome: { status: 'report', report: { started: false, errors: 0, warnings: 0, messages: [] } },
      expect: (t) => expect(t).toBe('Clean — no compiler errors.'),
    },
    {
      name: 'no-compile',
      outcome: { status: 'no-compile' },
      expect: (t) => expect(t).toBe('Assets refreshed — no recompile was needed.'),
    },
    {
      name: 'unknown/timeout',
      outcome: { status: 'unknown', reason: 'timeout' },
      expect: (t) => expect(t).toContain('Compile status unknown'),
    },
    {
      name: 'unknown/bridge-lost',
      outcome: { status: 'unknown', reason: 'bridge-lost' },
      expect: (t) => expect(t).toContain('Unity bridge was lost mid-compile'),
    },
    {
      name: 'unknown/editor-asleep canWake:false',
      outcome: { status: 'unknown', reason: 'editor-asleep', canWake: false },
      expect: (t) => expect(t).toContain('focuses the Unity window'),
    },
    {
      name: 'unknown/editor-asleep canWake:true',
      outcome: { status: 'unknown', reason: 'editor-asleep', canWake: true },
      expect: (t) => expect(t).toContain('as soon as Unity ticks'),
    },
    {
      name: 'unknown/aborted',
      outcome: { status: 'unknown', reason: 'aborted' },
      expect: (t) => expect(t.length > 0).toBe(true),
    },
  ];

  for (const c of outcomeCases) {
    it(`recompile:true — ${c.name}`, async () => {
      const tool = createGetCompileErrors(idleClient, compileDeps({ recompile: async () => c.outcome }));
      const res = await tool.execute('id', { recompile: true }, undefined, undefined);
      c.expect(textOf(res));
    });
  }

  it('recompile:true forwards the abort signal to deps.recompile', async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const tool = createGetCompileErrors(
      idleClient,
      compileDeps({
        recompile: async (opts) => {
          seenSignal = opts.signal;
          return { status: 'no-compile' };
        },
      }),
    );
    await tool.execute('id', { recompile: true }, controller.signal, undefined);
    expect(seenSignal).toBe(controller.signal);
  });

  it('has a 95s timeoutMs (OVERALL_TIMEOUT_MS + 5s)', () => {
    const tool = createGetCompileErrors(idleClient, compileDeps());
    expect(tool.timeoutMs).toBe(95_000);
  });
});
