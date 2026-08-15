import { describe, it, expect } from 'bun:test';
import { Type } from '@sinclair/typebox';
import { withUnityCompileGate as createCompileGate, resetCompileGate, type CompileGateDeps } from './compile-gate';
import type { HintLookup } from './compile-hints';
import type { AgentTool, AgentToolResult } from '../vendor/types';
import type { CompileWaitOutcome } from '../../../unity-bridge';
import type { CompilerMessage } from '../../../../types/unity';

const CWD = '/proj';

function fakeTool(resultText: string): AgentTool {
  return {
    name: 'write',
    label: 'write',
    description: 'fake write tool',
    parameters: Type.Object({}),
    async execute(): Promise<AgentToolResult> {
      return { content: [{ type: 'text', text: resultText }] };
    },
  };
}

const idleClient: HintLookup = {
  lookup: async () => ({ ok: true, data: [] }),
  search: async () => ({ ok: true, data: [] }),
};

function makeDeps(
  outcome: CompileWaitOutcome,
  overrides: Partial<CompileGateDeps> = {},
): { deps: CompileGateDeps; recompiles: () => number; warns: () => number } {
  let recompiles = 0;
  let warns = 0;
  const deps: CompileGateDeps = {
    recompile: async () => {
      recompiles++;
      return outcome;
    },
    connected: () => true,
    warnBridgeDisconnected: () => {
      warns++;
    },
    ...overrides,
  };
  return { deps, recompiles: () => recompiles, warns: () => warns };
}

function textOf(res: AgentToolResult): string {
  return res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
}

function errorReport(messages: CompilerMessage[]): CompileWaitOutcome {
  return {
    status: 'report',
    report: {
      started: false,
      success: messages.every((m) => m.type !== 'Error'),
      errors: messages.filter((m) => m.type === 'Error').length,
      warnings: 0,
      messages,
    },
  };
}

const OK_WRITE = 'Successfully wrote 10 bytes (1 lines) to /proj/Assets/Foo.cs';

describe('withUnityCompileGate', () => {
  it('does not trigger a recompile for a FAILED write', async () => {
    resetCompileGate();
    const { deps, recompiles } = makeDeps({ status: 'no-compile' });
    const gate = createCompileGate(fakeTool('Error: disk full'), CWD, idleClient, deps);
    const res = await gate.execute('id', { path: 'Assets/Foo.cs' }, undefined, undefined);
    expect(recompiles()).toBe(0);
    expect(textOf(res)).toBe('Error: disk full');
  });

  it('appends an honest not-connected note and warns exactly once per send', async () => {
    resetCompileGate();
    const { deps, recompiles, warns } = makeDeps({ status: 'no-compile' }, { connected: () => false });
    const gate = createCompileGate(fakeTool(OK_WRITE), CWD, idleClient, deps);

    const res1 = await gate.execute('id', { path: 'Assets/Foo.cs' }, undefined, undefined);
    const res2 = await gate.execute('id', { path: 'Assets/Bar.cs' }, undefined, undefined);

    expect(recompiles()).toBe(0);
    expect(textOf(res1)).toContain('[Unity compile] Unity bridge not connected');
    expect(textOf(res2)).toContain('[Unity compile] Unity bridge not connected');
    expect(warns()).toBe(1);

    resetCompileGate();
    await gate.execute('id', { path: 'Assets/Foo.cs' }, undefined, undefined);
    expect(warns()).toBe(2);
  });

  it('reports a no-compile outcome as such (not as a clean compile)', async () => {
    resetCompileGate();
    const { deps } = makeDeps({ status: 'no-compile' });
    const gate = createCompileGate(fakeTool(OK_WRITE), CWD, idleClient, deps);
    const res = await gate.execute('id', { path: 'Assets/Foo.cs' }, undefined, undefined);
    expect(textOf(res)).toContain('[Unity compile] Assets refreshed — no recompile was needed.');
  });

  it('reports unknown/timeout honestly instead of staying silent', async () => {
    resetCompileGate();
    const { deps } = makeDeps({ status: 'unknown', reason: 'timeout' });
    const gate = createCompileGate(fakeTool(OK_WRITE), CWD, idleClient, deps);
    const res = await gate.execute('id', { path: 'Assets/Foo.cs' }, undefined, undefined);
    expect(textOf(res)).toContain('[Unity compile] Compile status unknown');
    expect(textOf(res)).toContain('verify before finishing');
  });

  it('reports unknown/bridge-lost honestly', async () => {
    resetCompileGate();
    const { deps } = makeDeps({ status: 'unknown', reason: 'bridge-lost' });
    const gate = createCompileGate(fakeTool(OK_WRITE), CWD, idleClient, deps);
    const res = await gate.execute('id', { path: 'Assets/Foo.cs' }, undefined, undefined);
    expect(textOf(res)).toContain('[Unity compile] Compile status unknown');
  });

  it('returns the result unchanged on unknown/aborted', async () => {
    resetCompileGate();
    const { deps } = makeDeps({ status: 'unknown', reason: 'aborted' });
    const gate = createCompileGate(fakeTool(OK_WRITE), CWD, idleClient, deps);
    const res = await gate.execute('id', { path: 'Assets/Foo.cs' }, undefined, undefined);
    expect(textOf(res)).toBe(OK_WRITE);
  });

  it('feeds real compiler errors back with the repair note', async () => {
    resetCompileGate();
    const { deps } = makeDeps(
      errorReport([
        { file: 'Assets/Foo.cs', line: 3, column: 1, message: "CS1061: 'Rigidbody' has no 'Fly'", type: 'Error' },
      ]),
    );
    const gate = createCompileGate(fakeTool(OK_WRITE), CWD, idleClient, deps);
    const res = await gate.execute('id', { path: 'Assets/Foo.cs' }, undefined, undefined);
    expect(textOf(res)).toContain('[Unity compile] 1 compiler error(s)');
    expect(textOf(res)).toContain('line 3');
  });

  it('appends the clean note on a clean report', async () => {
    resetCompileGate();
    const { deps } = makeDeps(errorReport([]));
    const gate = createCompileGate(fakeTool(OK_WRITE), CWD, idleClient, deps);
    const res = await gate.execute('id', { path: 'Assets/Foo.cs' }, undefined, undefined);
    expect(textOf(res)).toContain('[Unity compile] Clean — no compiler errors.');
  });

  it('bounds hint lookups: a hanging HintLookup cannot stall the result', async () => {
    resetCompileGate();
    const hangingClient: HintLookup = {
      lookup: () => new Promise(() => {}),
      search: () => new Promise(() => {}),
    };
    const { deps } = makeDeps(
      errorReport([
        {
          file: 'Assets/Foo.cs',
          line: 3,
          column: 1,
          message: "CS1061: 'Rigidbody' does not contain a definition for 'Fly'",
          type: 'Error',
        },
      ]),
    );
    const gate = createCompileGate(fakeTool(OK_WRITE), CWD, idleClient, deps, { hintsBudgetMs: 30 });
    // Swap client: create directly with the hanging client instead.
    const gate2 = createCompileGate(fakeTool(OK_WRITE), CWD, hangingClient, deps, { hintsBudgetMs: 30 });
    const res = await gate2.execute('id', { path: 'Assets/Foo.cs' }, undefined, undefined);
    expect(textOf(res)).toContain('[Unity compile] 1 compiler error(s)');
    void gate;
  });
});
