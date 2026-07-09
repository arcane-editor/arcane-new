import { describe, it, expect } from 'bun:test';
import { Type } from '@sinclair/typebox';
import { withResultDiffs, type DiffDecoratorDeps } from './diff-decorator';
import type { AgentTool, AgentToolResult } from './vendor/types';

const CWD = '/proj';

function fakeTool(resultText: string, name: 'write' | 'edit' = 'write'): AgentTool {
  return {
    name,
    label: name,
    description: 'fake',
    parameters: Type.Object({}),
    async execute(): Promise<AgentToolResult> {
      return { content: [{ type: 'text', text: resultText }] };
    },
  };
}

/** Returns pre-programmed values in order, one per call (last value repeats once exhausted). */
function queueReader(values: Array<string | null>): DiffDecoratorDeps['readFile'] {
  let i = 0;
  return async () => {
    const v = values[Math.min(i, values.length - 1)];
    i++;
    return v;
  };
}

describe('withResultDiffs', () => {
  it('attaches old/new text for a modified file', async () => {
    const tool = withResultDiffs(fakeTool('Successfully edited /proj/Foo.cs'), CWD, {
      deps: { readFile: queueReader(['old content\n', 'new content\n']) },
    });

    const res = await tool.execute('call-1', { path: 'Foo.cs' });

    expect(res.diffs).toEqual([
      { path: '/proj/Foo.cs', oldText: 'old content\n', newText: 'new content\n' },
    ]);
  });

  it('uses an empty oldText for a newly created file (pre-read misses)', async () => {
    const tool = withResultDiffs(fakeTool('Successfully wrote 18 bytes (1 lines) to /proj/New.cs'), CWD, {
      deps: { readFile: queueReader([null, 'brand new content\n']) },
    });

    const res = await tool.execute('call-1', { path: 'New.cs' });

    expect(res.diffs).toEqual([
      { path: '/proj/New.cs', oldText: '', newText: 'brand new content\n' },
    ]);
  });

  it('attaches no diffs when the inner call failed and never wrote (file unchanged before/after)', async () => {
    const inner = fakeTool('Error: File not found: /proj/Missing.cs', 'edit');
    const tool = withResultDiffs(inner, CWD, {
      deps: { readFile: queueReader(['same content\n', 'same content\n']) },
    });

    const res = await tool.execute('call-1', { path: 'Missing.cs' });

    expect(res.diffs).toBeUndefined();
  });

  it('attaches no diffs when the write produced identical content', async () => {
    const tool = withResultDiffs(fakeTool('Successfully wrote 9 bytes (1 lines) to /proj/Same.cs'), CWD, {
      deps: { readFile: queueReader(['unchanged\n', 'unchanged\n']) },
    });

    const res = await tool.execute('call-1', { path: 'Same.cs' });

    expect(res.diffs).toBeUndefined();
  });

  it('does not mutate the inner tool result object (spreads a new one)', async () => {
    const innerResult: AgentToolResult = { content: [{ type: 'text', text: 'ok' }] };
    const inner: AgentTool = {
      name: 'edit',
      label: 'edit',
      description: 'fake',
      parameters: Type.Object({}),
      async execute() {
        return innerResult;
      },
    };
    const tool = withResultDiffs(inner, CWD, {
      deps: { readFile: queueReader(['old\n', 'new\n']) },
    });

    const res = await tool.execute('call-1', { path: 'Foo.cs' });

    expect(res).not.toBe(innerResult);
    expect(innerResult.diffs).toBeUndefined();
    expect(res.content).toBe(innerResult.content);
  });

  it('skips diffing (and never reads) when there is no path param', async () => {
    let readCalled = false;
    const tool = withResultDiffs(fakeTool('ok'), CWD, {
      deps: {
        readFile: async () => {
          readCalled = true;
          return null;
        },
      },
    });

    const res = await tool.execute('call-1', {});

    expect(readCalled).toBe(false);
    expect(res.diffs).toBeUndefined();
  });

  it('skips diffing for a path outside allowedRoot — the inner tool rejects it itself', async () => {
    let readCalled = false;
    const inner = fakeTool("Error: '/proj/Secrets.cs' is outside the allowed project area.");
    const tool = withResultDiffs(inner, CWD, {
      allowedRoot: '/proj/Assets',
      deps: {
        readFile: async () => {
          readCalled = true;
          return 'x';
        },
      },
    });

    const res = await tool.execute('call-1', { path: 'Secrets.cs' });

    expect(readCalled).toBe(false);
    expect(res.diffs).toBeUndefined();
  });

  it('resolves the path relative to cwd for the diff path field', async () => {
    const tool = withResultDiffs(fakeTool('Successfully edited /proj/sub/Foo.cs'), CWD, {
      deps: { readFile: queueReader(['a\n', 'b\n']) },
    });

    const res = await tool.execute('call-1', { path: 'sub/Foo.cs' });

    expect(res.diffs?.[0].path).toBe('/proj/sub/Foo.cs');
  });
});
