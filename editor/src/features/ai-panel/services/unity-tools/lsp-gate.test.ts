import { describe, it, expect } from 'bun:test';
import { Type } from '@sinclair/typebox';
import { withLspDiagnosticsGate, type DiagnosticsFetcher } from './lsp-gate';
import type { AgentTool, AgentToolResult } from '../vendor/types';
import type { FileDiag } from '../../../lsp';

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

function countingFetcher(diagnostics: FileDiag[]): { fetcher: DiagnosticsFetcher; calls: () => number } {
  let calls = 0;
  return {
    fetcher: async () => {
      calls++;
      return diagnostics;
    },
    calls: () => calls,
  };
}

describe('withLspDiagnosticsGate', () => {
  it('appends ERROR-severity diagnostics in the exact sentinel format after a successful write', async () => {
    const diagnostics: FileDiag[] = [
      { line: 12, severity: 'error', message: "'Rigidbody' does not contain a definition for 'Fly'", code: 'CS1061' },
      { line: 20, severity: 'error', message: 'unexpected token' },
    ];
    const { fetcher } = countingFetcher(diagnostics);
    const gate = withLspDiagnosticsGate(fakeTool('Successfully wrote 10 bytes (1 lines) to /proj/Foo.cs'), CWD, fetcher);

    const res = await gate.execute('call-1', { path: 'Foo.cs', content: 'class Foo {}' });
    const text = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');

    expect(text).toContain(
      '\n\n[C# language server] 2 error(s) in Foo.cs:\n' +
        "  • line 12: 'Rigidbody' does not contain a definition for 'Fly' (CS1061)\n" +
        '  • line 20: unexpected token',
    );
  });

  it('filters out non-error severities and appends nothing when only warnings/info are present', async () => {
    const diagnostics: FileDiag[] = [
      { line: 3, severity: 'warning', message: 'unused variable' },
      { line: 4, severity: 'info', message: 'consider using var' },
    ];
    const { fetcher } = countingFetcher(diagnostics);
    const inner = fakeTool('Successfully wrote 10 bytes (1 lines) to /proj/Foo.cs');
    const gate = withLspDiagnosticsGate(inner, CWD, fetcher);

    const res = await gate.execute('call-1', { path: 'Foo.cs', content: 'class Foo {}' });
    const innerRes = await inner.execute('call-1', { path: 'Foo.cs', content: 'class Foo {}' });
    expect(res).toEqual(innerRes);
  });

  it('leaves the result untouched when the fetcher returns no diagnostics at all', async () => {
    const { fetcher, calls } = countingFetcher([]);
    const inner = fakeTool('Successfully wrote 10 bytes (1 lines) to /proj/Foo.cs');
    const gate = withLspDiagnosticsGate(inner, CWD, fetcher);

    const res = await gate.execute('call-1', { path: 'Foo.cs', content: 'class Foo {}' });
    const innerRes = await inner.execute('call-1', { path: 'Foo.cs', content: 'class Foo {}' });
    expect(res).toEqual(innerRes);
    expect(calls()).toBe(1);
  });

  it('never calls the fetcher for a non-.cs path', async () => {
    const { fetcher, calls } = countingFetcher([{ line: 1, severity: 'error', message: 'boom' }]);
    const gate = withLspDiagnosticsGate(fakeTool('Successfully wrote 3 bytes (1 lines) to /proj/Foo.ts'), CWD, fetcher);

    await gate.execute('call-1', { path: 'Foo.ts', content: 'const x = 1;' });
    expect(calls()).toBe(0);
  });

  it('never calls the fetcher when the inner write tool call failed', async () => {
    const { fetcher, calls } = countingFetcher([{ line: 1, severity: 'error', message: 'boom' }]);
    const gate = withLspDiagnosticsGate(fakeTool('Error writing file: disk full'), CWD, fetcher);

    const res = await gate.execute('call-1', { path: 'Foo.cs', content: 'class Foo {}' });
    expect(calls()).toBe(0);
    expect(res.content[0]).toEqual({ type: 'text', text: 'Error writing file: disk full' });
  });

  it('never calls the fetcher when the inner edit tool call failed to apply', async () => {
    const { fetcher, calls } = countingFetcher([{ line: 1, severity: 'error', message: 'boom' }]);
    const gate = withLspDiagnosticsGate(fakeTool('Edit 1: Could not find text to replace:\n"foo"'), CWD, fetcher);

    await gate.execute('call-1', { path: 'Foo.cs' });
    expect(calls()).toBe(0);
  });

  it('leaves the result untouched (never breaks the tool call) when the fetcher throws', async () => {
    const throwingFetcher: DiagnosticsFetcher = async () => {
      throw new Error('lsp client exploded');
    };
    const inner = fakeTool('Successfully wrote 10 bytes (1 lines) to /proj/Foo.cs');
    const gate = withLspDiagnosticsGate(inner, CWD, throwingFetcher);

    const res = await gate.execute('call-1', { path: 'Foo.cs', content: 'class Foo {}' });
    const innerRes = await inner.execute('call-1', { path: 'Foo.cs', content: 'class Foo {}' });
    expect(res).toEqual(innerRes);
  });

  it('forwards the tool call abort signal into the fetcher', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const fetcher: DiagnosticsFetcher = async (_absPath, _content, signal) => {
      receivedSignal = signal;
      return [];
    };
    const inner = fakeTool('Successfully wrote 10 bytes (1 lines) to /proj/Foo.cs');
    const gate = withLspDiagnosticsGate(inner, CWD, fetcher);

    await gate.execute('call-1', { path: 'Foo.cs', content: 'class Foo {}' }, controller.signal);

    expect(receivedSignal).toBe(controller.signal);
  });

  it('leaves the result untouched when the tool call is aborted (fetcher observes the aborted signal, returns nothing new)', async () => {
    const controller = new AbortController();
    const fetcher: DiagnosticsFetcher = async (_absPath, _content, signal) => {
      // Mirrors requestFileDiagnostics's real abort behavior: resolve to []
      // once the signal is aborted, instead of throwing or hanging.
      if (signal?.aborted) return [];
      return [{ line: 1, severity: 'error', message: 'should not appear' }];
    };
    const inner = fakeTool('Successfully wrote 10 bytes (1 lines) to /proj/Foo.cs');
    const gate = withLspDiagnosticsGate(inner, CWD, fetcher);

    controller.abort();
    const res = await gate.execute('call-1', { path: 'Foo.cs', content: 'class Foo {}' }, controller.signal);
    const innerRes = await inner.execute('call-1', { path: 'Foo.cs', content: 'class Foo {}' });

    expect(res).toEqual(innerRes);
  });

  it('recognizes a successful edit result (not just write)', async () => {
    const diagnostics: FileDiag[] = [{ line: 5, severity: 'error', message: 'CS0246 missing type' }];
    const { fetcher } = countingFetcher(diagnostics);
    const gate = withLspDiagnosticsGate(
      fakeTool('Successfully edited /proj/Foo.cs\n\n--- diff ---'),
      CWD,
      fetcher,
    );

    const res = await gate.execute('call-1', { path: 'Foo.cs', content: 'class Foo {}' });
    const text = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(text).toContain('[C# language server] 1 error(s) in Foo.cs:');
    expect(text).toContain('  • line 5: CS0246 missing type');
  });
});
