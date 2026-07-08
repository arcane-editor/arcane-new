import { describe, it, expect, beforeEach } from 'bun:test';
import { Type } from '@sinclair/typebox';
import { withRepeatCallGuard, resetRepeatCallGuard, stableStringify } from './tool-guards';
import { resetTurnTelemetry, nextTurnTelemetry } from './turn-telemetry';
import type { AgentTool, AgentToolResult } from './vendor/types';

function fakeTool(name: string, resultText = `${name}-result`): { tool: AgentTool; calls: () => number } {
  let calls = 0;
  const tool: AgentTool = {
    name,
    label: name,
    description: `fake ${name}`,
    parameters: Type.Object({}),
    async execute(): Promise<AgentToolResult> {
      calls++;
      return { content: [{ type: 'text', text: resultText }] };
    },
  };
  return { tool, calls: () => calls };
}

describe('stableStringify', () => {
  it('is stable across key order', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it('differs for different values', () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });
});

describe('withRepeatCallGuard', () => {
  beforeEach(() => {
    resetRepeatCallGuard();
    resetTurnTelemetry();
  });

  it('suppresses an exact repeat call without executing the inner tool', async () => {
    const { tool, calls } = fakeTool('bash');
    const guarded = withRepeatCallGuard(tool);

    const first = await guarded.execute('c1', { command: 'ls' });
    const second = await guarded.execute('c2', { command: 'ls' });

    expect(calls()).toBe(1);
    expect(first.content[0]).toEqual({ type: 'text', text: 'bash-result' });
    const secondText = second.content[0].type === 'text' ? second.content[0].text : '';
    expect(secondText).toContain('You already called bash with identical arguments this task');
  });

  it('executes when arguments differ', async () => {
    const { tool, calls } = fakeTool('bash');
    const guarded = withRepeatCallGuard(tool);

    await guarded.execute('c1', { command: 'ls' });
    await guarded.execute('c2', { command: 'pwd' });

    expect(calls()).toBe(2);
  });

  it('exempts a read of a path that was written since the previous identical read', async () => {
    const read = fakeTool('read');
    const write = fakeTool('write');
    const guardedRead = withRepeatCallGuard(read.tool);
    const guardedWrite = withRepeatCallGuard(write.tool);

    await guardedRead.execute('c1', { path: 'Foo.cs' }); // first read
    await guardedWrite.execute('c2', { path: 'Foo.cs', content: 'x' }); // write marks it
    const third = await guardedRead.execute('c3', { path: 'Foo.cs' }); // exempted repeat read

    expect(read.calls()).toBe(2);
    expect(third.content[0]).toEqual({ type: 'text', text: 'read-result' });
  });

  it('suppresses a THIRD identical read when no new write happened after the exemption was consumed', async () => {
    const read = fakeTool('read');
    const write = fakeTool('write');
    const guardedRead = withRepeatCallGuard(read.tool);
    const guardedWrite = withRepeatCallGuard(write.tool);

    await guardedRead.execute('c1', { path: 'Foo.cs' }); // first read
    await guardedWrite.execute('c2', { path: 'Foo.cs', content: 'x' }); // write marks it
    await guardedRead.execute('c3', { path: 'Foo.cs' }); // exempted repeat, consumes the mark
    const fourth = await guardedRead.execute('c4', { path: 'Foo.cs' }); // no new write — suppressed

    expect(read.calls()).toBe(2);
    const text = fourth.content[0].type === 'text' ? fourth.content[0].text : '';
    expect(text).toContain('You already called read with identical arguments this task');
  });

  it('suppresses an identical write/edit repeat (no read exemption applies to writes)', async () => {
    const { tool, calls } = fakeTool('write');
    const guarded = withRepeatCallGuard(tool);

    await guarded.execute('c1', { path: 'Foo.cs', content: 'x' });
    await guarded.execute('c2', { path: 'Foo.cs', content: 'x' });

    expect(calls()).toBe(1);
  });

  it('reset clears both the call-count and written-since registries', async () => {
    const { tool, calls } = fakeTool('bash');
    const guarded = withRepeatCallGuard(tool);

    await guarded.execute('c1', { command: 'ls' });
    resetRepeatCallGuard();
    await guarded.execute('c2', { command: 'ls' }); // fresh send — not a repeat

    expect(calls()).toBe(2);
  });

  it('increments the loopGuardHits telemetry counter on each suppression', async () => {
    const { tool } = fakeTool('bash');
    const guarded = withRepeatCallGuard(tool);

    await guarded.execute('c1', { command: 'ls' });
    await guarded.execute('c2', { command: 'ls' });
    await guarded.execute('c3', { command: 'ls' });

    expect(nextTurnTelemetry().loopGuardHits).toBe(2);
  });
});
