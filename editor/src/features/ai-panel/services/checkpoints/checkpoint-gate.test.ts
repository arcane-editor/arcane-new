import { describe, it, expect } from 'bun:test';
import { Type } from '@sinclair/typebox';
import { withCheckpoint, type CheckpointGateDeps } from './checkpoint-gate';
import type { AgentTool, AgentToolResult } from '../vendor/types';

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

/** A stateful fake mirroring the real store's dedupe semantics: first snapshot per path wins. */
function fakeRecorder(): {
  deps: Pick<CheckpointGateDeps, 'readBeforeContent' | 'recordPreWrite'>;
  recorded: Map<string, string | null>;
  callLog: Array<{ path: string; before: string | null }>;
} {
  const recorded = new Map<string, string | null>();
  const callLog: Array<{ path: string; before: string | null }> = [];
  return {
    recorded,
    callLog,
    deps: {
      readBeforeContent: async (absPath: string) => `disk-content-for-${absPath}`,
      recordPreWrite: (absPath, before) => {
        callLog.push({ path: absPath, before });
        if (!recorded.has(absPath)) recorded.set(absPath, before);
      },
    },
  };
}

describe('withCheckpoint', () => {
  it('records the pre-write snapshot BEFORE delegating to the inner tool', async () => {
    const order: string[] = [];
    const deps: CheckpointGateDeps = {
      isEnabled: () => true,
      readBeforeContent: async () => {
        order.push('read');
        return 'before-content';
      },
      recordPreWrite: () => order.push('record'),
    };
    const inner: AgentTool = {
      name: 'write',
      label: 'write',
      description: 'fake',
      parameters: Type.Object({}),
      async execute() {
        order.push('delegate');
        return { content: [{ type: 'text', text: 'Successfully wrote 1 bytes (1 lines) to /proj/Foo.cs' }] };
      },
    };
    const gate = withCheckpoint(inner, CWD, deps);

    await gate.execute('call-1', { path: 'Foo.cs', content: 'x' });

    expect(order).toEqual(['read', 'record', 'delegate']);
  });

  it('passes null to recordPreWrite when the file does not exist yet', async () => {
    let recordedWith: string | null | undefined;
    const deps: CheckpointGateDeps = {
      isEnabled: () => true,
      readBeforeContent: async () => null,
      recordPreWrite: (_path, before) => {
        recordedWith = before;
      },
    };
    const gate = withCheckpoint(fakeTool('Successfully wrote 1 bytes (1 lines) to /proj/New.cs'), CWD, deps);

    await gate.execute('call-1', { path: 'New.cs', content: 'x' });

    expect(recordedWith).toBeNull();
  });

  it('resolves the absolute path (relative to cwd) before recording', async () => {
    let recordedPath: string | undefined;
    const deps: CheckpointGateDeps = {
      isEnabled: () => true,
      readBeforeContent: async (absPath) => {
        recordedPath = absPath;
        return null;
      },
      recordPreWrite: () => {},
    };
    const gate = withCheckpoint(fakeTool('Successfully wrote 1 bytes (1 lines) to /proj/Foo.cs'), CWD, deps);

    await gate.execute('call-1', { path: 'Foo.cs', content: 'x' });

    expect(recordedPath).toBe('/proj/Foo.cs');
  });

  it('dedupes: calling the gate twice for the same path only keeps the first snapshot (store-like recorder semantics)', async () => {
    const { deps, recorded, callLog } = fakeRecorder();
    const gate = withCheckpoint(
      fakeTool('Successfully wrote 1 bytes (1 lines) to /proj/Foo.cs'),
      CWD,
      { isEnabled: () => true, ...deps },
    );

    await gate.execute('call-1', { path: 'Foo.cs', content: 'v1' });
    await gate.execute('call-2', { path: 'Foo.cs', content: 'v2' });

    // The gate itself calls the recorder every time (it has no per-path memory of
    // its own — dedupe is the store's job) ...
    expect(callLog).toHaveLength(2);
    // ... but a store-like recorder keeps only the first snapshot per path.
    expect(recorded.size).toBe(1);
    expect(recorded.get('/proj/Foo.cs')).toBe('disk-content-for-/proj/Foo.cs');
  });

  it('setting-off bypasses entirely: no read, no record, straight delegate', async () => {
    let readCalled = false;
    let recordCalled = false;
    const deps: CheckpointGateDeps = {
      isEnabled: () => false,
      readBeforeContent: async () => {
        readCalled = true;
        return null;
      },
      recordPreWrite: () => {
        recordCalled = true;
      },
    };
    const inner = fakeTool('Successfully wrote 1 bytes (1 lines) to /proj/Foo.cs');
    const gate = withCheckpoint(inner, CWD, deps);

    const res = await gate.execute('call-1', { path: 'Foo.cs', content: 'x' });
    const innerRes = await inner.execute('call-1', { path: 'Foo.cs', content: 'x' });

    expect(readCalled).toBe(false);
    expect(recordCalled).toBe(false);
    expect(res).toEqual(innerRes);
  });

  it('an inner tool failure still delegates the result untouched — the snapshot recorded beforehand is fine', async () => {
    let recordCalled = false;
    const deps: CheckpointGateDeps = {
      isEnabled: () => true,
      readBeforeContent: async () => 'before-content',
      recordPreWrite: () => {
        recordCalled = true;
      },
    };
    const inner = fakeTool('Error writing file: disk full');
    const gate = withCheckpoint(inner, CWD, deps);

    const res = await gate.execute('call-1', { path: 'Foo.cs', content: 'x' });

    expect(recordCalled).toBe(true);
    expect(res).toEqual({ content: [{ type: 'text', text: 'Error writing file: disk full' }] });
  });

  it('never touches the recorder when the tool call has no path param', async () => {
    let called = false;
    const deps: CheckpointGateDeps = {
      isEnabled: () => true,
      readBeforeContent: async () => null,
      recordPreWrite: () => {
        called = true;
      },
    };
    const inner = fakeTool('some result');
    const gate = withCheckpoint(inner, CWD, deps);

    await gate.execute('call-1', {});

    expect(called).toBe(false);
  });
});
