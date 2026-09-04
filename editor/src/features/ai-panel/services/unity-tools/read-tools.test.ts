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

  it('connected but pre-protocol-4: falls back to the session ring with the exact label', async () => {
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

  it('connected + protocol 4: reads via the RPC, no degraded note, source label is "Unity console"', async () => {
    let called = false;
    const tool = createGetConsoleErrors(
      consoleDeps({
        unitySnap: async () => ({ connected: true, bridgeProtocol: 4, logs: [] }),
        getConsoleSnapshot: async (opts) => {
          called = true;
          expect(opts.limit).toBe(50);
          return snapshot({
            source: 'logEntries',
            counts: { errors: 1, warnings: 0, logs: 0 },
            entries: [{ seq: 1, logType: 'Error', message: 'boom', stackTrace: '', file: 'Assets/Foo.cs', line: 3, mode: 'Unknown', count: 1 }],
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
    expect(text).toContain('(source: Unity console)');
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
    const text = renderConsoleErrors(entries, { errors: 3, warnings: 0, logs: 0 }, 'this session', '');
    expect(text).toContain('×3');
  });

  it('a single (uncollapsed) entry never shows a ×N suffix', () => {
    const text = renderConsoleErrors(
      [{ logType: 'Error', message: 'boom' }],
      { errors: 1, warnings: 0, logs: 0 },
      'this session',
      '',
    );
    expect(text).not.toContain('×');
  });
});

describe('get_console_errors — sinceTurnStart filter', () => {
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

  it('filters RPC entries by seq too', async () => {
    markConsoleTurnStart(10);
    const tool = createGetConsoleErrors(
      consoleDeps({
        unitySnap: async () => ({ connected: true, bridgeProtocol: 4, logs: [] }),
        getConsoleSnapshot: async () =>
          snapshot({
            counts: { errors: 2, warnings: 0, logs: 0 },
            entries: [
              { seq: 8, logType: 'Error', message: 'old-rpc', stackTrace: '', file: '', line: 0, mode: 'Unknown', count: 1 },
              { seq: 12, logType: 'Error', message: 'new-rpc', stackTrace: '', file: '', line: 0, mode: 'Unknown', count: 1 },
            ],
          }),
      }),
    );
    const res = await tool.execute('id', { sinceTurnStart: true }, undefined, undefined);
    const text = textOf(res);
    expect(text).toContain('new-rpc');
    expect(text).not.toContain('old-rpc');
    markConsoleTurnStart(0);
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

describe('get_compile_errors', () => {
  it('recompile:false with no prior compile: says so plainly, no engine round-trip', async () => {
    let recompileCalled = false;
    const tool = createGetCompileErrors(
      idleClient,
      compileDeps({ recompile: async () => { recompileCalled = true; return { status: 'no-compile' }; } }),
    );
    const res = await tool.execute('id', {}, undefined, undefined);
    expect(recompileCalled).toBe(false);
    expect(textOf(res)).toContain('No compile reported yet this session');
  });

  it('recompile:false with a prior clean compile', async () => {
    const clean: CompilationPayload = { started: false, success: true, errors: 0, warnings: 0, messages: [] };
    const tool = createGetCompileErrors(idleClient, compileDeps({ lastCompilation: async () => clean }));
    const res = await tool.execute('id', {}, undefined, undefined);
    expect(textOf(res)).toContain('Clean — no compiler errors.');
  });

  it('recompile:false with a prior error report: lists file:line: message', async () => {
    const report: CompilationPayload = {
      started: false,
      success: false,
      errors: 1,
      warnings: 0,
      messages: [{ file: 'Assets/Foo.cs', line: 5, column: 1, message: "CS1061: no 'Fly'", type: 'Error' }],
    };
    const tool = createGetCompileErrors(idleClient, compileDeps({ lastCompilation: async () => report }));
    const res = await tool.execute('id', {}, undefined, undefined);
    const text = textOf(res);
    expect(text).toContain('1 compiler error(s)');
    expect(text).toContain('Assets/Foo.cs:5:');
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
    expect(textOf(res).startsWith('[Unity compile]')).toBe(false);
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
