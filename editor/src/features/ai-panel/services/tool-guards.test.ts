import { describe, it, expect, beforeEach } from 'bun:test';
import { Type } from '@sinclair/typebox';
import { withRepeatCallGuard, resetRepeatCallGuard, stableStringify } from './tool-guards';
import { resetTurnTelemetry, nextTurnTelemetry } from './turn-telemetry';
import type { AgentTool, AgentToolResult } from './vendor/types';

const WS = '/ws';

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
    const guarded = withRepeatCallGuard(tool, WS);

    const first = await guarded.execute('c1', { command: 'ls' });
    const second = await guarded.execute('c2', { command: 'ls' });

    expect(calls()).toBe(1);
    expect(first.content[0]).toEqual({ type: 'text', text: 'bash-result' });
    const secondText = second.content[0].type === 'text' ? second.content[0].text : '';
    expect(secondText).toContain('You already called bash with identical arguments this task');
  });

  it('executes when arguments differ', async () => {
    const { tool, calls } = fakeTool('bash');
    const guarded = withRepeatCallGuard(tool, WS);

    await guarded.execute('c1', { command: 'ls' });
    await guarded.execute('c2', { command: 'pwd' });

    expect(calls()).toBe(2);
  });

  it('exempts a read of a path that was written since the previous identical read', async () => {
    const read = fakeTool('read');
    const write = fakeTool('write');
    const guardedRead = withRepeatCallGuard(read.tool, WS);
    const guardedWrite = withRepeatCallGuard(write.tool, WS);

    await guardedRead.execute('c1', { path: 'Foo.cs' }); // first read
    await guardedWrite.execute('c2', { path: 'Foo.cs', content: 'x' }); // write marks it
    const third = await guardedRead.execute('c3', { path: 'Foo.cs' }); // exempted repeat read

    expect(read.calls()).toBe(2);
    expect(third.content[0]).toEqual({ type: 'text', text: 'read-result' });
  });

  it('suppresses a THIRD identical read when no new write happened after the exemption was consumed', async () => {
    const read = fakeTool('read');
    const write = fakeTool('write');
    const guardedRead = withRepeatCallGuard(read.tool, WS);
    const guardedWrite = withRepeatCallGuard(write.tool, WS);

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
    const guarded = withRepeatCallGuard(tool, WS);

    await guarded.execute('c1', { path: 'Foo.cs', content: 'x' });
    await guarded.execute('c2', { path: 'Foo.cs', content: 'x' });

    expect(calls()).toBe(1);
  });

  it('a rejected write does not count as already-made — the identical retry executes', async () => {
    let calls = 0;
    const guarded = withRepeatCallGuard({
      name: 'write',
      label: 'write',
      description: 'fake write',
      parameters: Type.Object({}),
      async execute(): Promise<AgentToolResult> {
        calls++;
        return calls === 1
          ? ({
              content: [{ type: 'text', text: 'User rejected this edit' }],
              rejected: true,
            } as AgentToolResult)
          : { content: [{ type: 'text', text: 'Successfully wrote file' }] };
      },
    }, WS);

    const params = { path: 'Assets/A.cs', content: 'x' };
    await guarded.execute('c1', params);
    const second = await guarded.execute('c2', params);

    expect(calls).toBe(2); // not suppressed — the user changed their mind
    expect(second.content[0]).toEqual({ type: 'text', text: 'Successfully wrote file' });
  });

  it('a rejected write does not arm the post-write read exemption', async () => {
    const read = fakeTool('read');
    const guardedRead = withRepeatCallGuard(read.tool, WS);
    const guardedWrite = withRepeatCallGuard({
      name: 'write',
      label: 'write',
      description: 'fake write',
      parameters: Type.Object({}),
      async execute(): Promise<AgentToolResult> {
        return {
          content: [{ type: 'text', text: 'User rejected this edit' }],
          rejected: true,
        } as AgentToolResult;
      },
    }, WS);

    await guardedRead.execute('c1', { path: 'Assets/A.cs' });
    await guardedWrite.execute('c2', { path: 'Assets/A.cs', content: 'x' }); // rejected — no write landed
    const third = await guardedRead.execute('c3', { path: 'Assets/A.cs' });

    expect(read.calls()).toBe(1); // second read suppressed: nothing was written
    const text = third.content[0].type === 'text' ? third.content[0].text : '';
    expect(text).toContain('You already called read with identical arguments this task');
  });

  it('reset clears both the call-count and written-since registries', async () => {
    const { tool, calls } = fakeTool('bash');
    const guarded = withRepeatCallGuard(tool, WS);

    await guarded.execute('c1', { command: 'ls' });
    resetRepeatCallGuard();
    await guarded.execute('c2', { command: 'ls' }); // fresh send — not a repeat

    expect(calls()).toBe(2);
  });

  it('increments the loopGuardHits telemetry counter on each suppression', async () => {
    const { tool } = fakeTool('bash');
    const guarded = withRepeatCallGuard(tool, WS);

    await guarded.execute('c1', { command: 'ls' });
    await guarded.execute('c2', { command: 'ls' });
    await guarded.execute('c3', { command: 'ls' });

    expect(nextTurnTelemetry().loopGuardHits).toBe(2);
  });
});

// The guard keyed on the RAW argument text, so the same file under a different
// spelling was a different call — the model could loop on it forever, and the
// post-write read exemption (also path-keyed) never matched across spellings.
describe('withRepeatCallGuard — path spelling', () => {
  beforeEach(() => {
    resetRepeatCallGuard();
    resetTurnTelemetry();
  });

  it('treats "./Foo.cs" and "Foo.cs" as the same call', async () => {
    const { tool, calls } = fakeTool('read');
    const guarded = withRepeatCallGuard(tool, WS);

    await guarded.execute('c1', { path: 'Assets/Foo.cs' });
    await guarded.execute('c2', { path: './Assets/Foo.cs' });

    expect(calls()).toBe(1);
  });

  it('collapses a relative and an absolute spelling of the same file', async () => {
    const { tool, calls } = fakeTool('read');
    const guarded = withRepeatCallGuard(tool, WS);

    await guarded.execute('c1', { path: 'Assets/Foo.cs' });
    await guarded.execute('c2', { path: '/ws/Assets/Foo.cs' });

    expect(calls()).toBe(1);
  });

  it('collapses a path that walks through a parent segment', async () => {
    const { tool, calls } = fakeTool('read');
    const guarded = withRepeatCallGuard(tool, WS);

    await guarded.execute('c1', { path: 'Assets/Foo.cs' });
    await guarded.execute('c2', { path: 'Assets/Sub/../Foo.cs' });

    expect(calls()).toBe(1);
  });

  it('still treats genuinely different files as different calls', async () => {
    const { tool, calls } = fakeTool('read');
    const guarded = withRepeatCallGuard(tool, WS);

    await guarded.execute('c1', { path: 'Assets/Foo.cs' });
    await guarded.execute('c2', { path: 'Assets/Bar.cs' });

    expect(calls()).toBe(2);
  });

  it('arms the post-write read exemption across spellings', async () => {
    const read = fakeTool('read');
    const guardedRead = withRepeatCallGuard(read.tool, WS);
    const write = fakeTool('write', 'Successfully wrote file');
    const guardedWrite = withRepeatCallGuard(write.tool, WS);

    await guardedRead.execute('c1', { path: 'Assets/A.cs' });
    await guardedWrite.execute('c2', { path: './Assets/A.cs', content: 'x' });
    // The re-read after a write must go through — under the old raw-text key
    // the write armed './Assets/A.cs' and this read asked for 'Assets/A.cs'.
    await guardedRead.execute('c3', { path: 'Assets/A.cs' });

    expect(read.calls()).toBe(2);
  });

  it('passes the ORIGINAL params to the inner tool, not the normalized ones', async () => {
    let seen: unknown;
    const tool: AgentTool = {
      name: 'read',
      label: 'read',
      description: 'fake',
      parameters: Type.Object({}),
      async execute(_id, params): Promise<AgentToolResult> {
        seen = params;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    };
    const guarded = withRepeatCallGuard(tool, WS);

    await guarded.execute('c1', { path: './Assets/Foo.cs' });
    expect((seen as { path: string }).path).toBe('./Assets/Foo.cs');
  });
});

describe('withRepeatCallGuard — the design loop’s render step', () => {
  const DOC = 'Assets/UI/MainMenu.uxml';

  function toolNamed(name: string, text: string): AgentTool {
    return {
      name,
      label: name,
      description: '',
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: 'text', text }] };
      },
    } as unknown as AgentTool;
  }

  function textOf(res: AgentToolResult): string {
    return res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
  }

  beforeEach(() => resetRepeatCallGuard());

  it('suppresses a second identical layout call with no write between them', async () => {
    const layout = withRepeatCallGuard(toolNamed('unity_ui_layout', 'boxes'), WS);
    await layout.execute('1', { document: DOC });
    expect(textOf(await layout.execute('2', { document: DOC }))).toContain('already called');
  });

  it('lets the layout repeat once after a unity_ui_write lands', async () => {
    // The design prompt's own step 5: fix what the render reported, render
    // again. Same tool, same arguments, genuinely different answer.
    const layout = withRepeatCallGuard(toolNamed('unity_ui_layout', 'boxes'), WS);
    const write = withRepeatCallGuard(
      toolNamed('unity_ui_write', 'Wrote Assets/UI/MainMenu.uss (guid abc).'),
      WS,
    );

    await layout.execute('1', { document: DOC });
    await write.execute('2', { path: 'Assets/UI/MainMenu.uss', content: '.a{}' });
    expect(textOf(await layout.execute('3', { document: DOC }))).toBe('boxes');
  });

  it('does not arm the exemption for a write that was refused', async () => {
    const layout = withRepeatCallGuard(toolNamed('unity_ui_layout', 'boxes'), WS);
    const write = withRepeatCallGuard(
      toolNamed('unity_ui_write', 'Not writing Assets/UI/MainMenu.uss: box-shadow is not USS.'),
      WS,
    );

    await layout.execute('1', { document: DOC });
    await write.execute('2', { path: 'Assets/UI/MainMenu.uss', content: '.a{}' });
    // Nothing reached disk, so the render really would be identical.
    expect(textOf(await layout.execute('3', { document: DOC }))).toContain('already called');
  });

  it('spends the exemption on one repeat, not every repeat', async () => {
    const layout = withRepeatCallGuard(toolNamed('unity_ui_layout', 'boxes'), WS);
    const write = withRepeatCallGuard(
      toolNamed('unity_ui_write', 'Wrote Assets/UI/MainMenu.uss (guid abc).'),
      WS,
    );

    await layout.execute('1', { document: DOC });
    await write.execute('2', { path: 'Assets/UI/MainMenu.uss', content: '.a{}' });
    await layout.execute('3', { document: DOC });
    expect(textOf(await layout.execute('4', { document: DOC }))).toContain('already called');
  });
});
