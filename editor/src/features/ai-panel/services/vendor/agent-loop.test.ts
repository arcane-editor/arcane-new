import { describe, it, expect } from 'bun:test';
import { agentLoop, DEFAULT_TOOL_TIMEOUT_MS } from './agent-loop';
import { AssistantMessageEventStream } from './event-stream';
import { Type } from '@sinclair/typebox';
import type { AgentLoopConfig, AgentMessage, AgentTool, StreamFn, ToolResultMessage } from './types';

/** First LLM turn asks for the given tool; second turn stops cleanly. */
function toolCallThenStop(toolName: string): StreamFn {
  let call = 0;
  return () => {
    const s = new AssistantMessageEventStream();
    s.push({ type: 'start' });
    call++;
    if (call === 1) {
      s.push({
        type: 'done',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 't1', name: toolName, arguments: {} }],
          stopReason: 'toolUse',
          timestamp: 1,
        },
      });
    } else {
      s.push({
        type: 'done',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop', timestamp: 2 },
      });
    }
    return s;
  };
}

function makeConfig(streamFn: StreamFn, signal?: AbortSignal): AgentLoopConfig {
  return {
    model: { id: 'x', name: 'x', provider: 'test' },
    streamFn,
    convertToLlm: (m) => m as never,
    signal,
  } as AgentLoopConfig;
}

function baseTool(overrides: Partial<AgentTool>): AgentTool {
  return {
    name: 'slow',
    label: 'slow',
    description: 'never resolves',
    parameters: Type.Object({}),
    execute: () => new Promise(() => {}),
    ...overrides,
  } as AgentTool;
}

async function run(config: AgentLoopConfig, tools: AgentTool[]): Promise<AgentMessage[]> {
  const prompts: AgentMessage[] = [{ role: 'user', content: 'go', timestamp: 0 } as AgentMessage];
  const stream = agentLoop(config, { systemPrompt: 'sys', messages: [], tools }, prompts);
  let final: AgentMessage[] = [];
  for await (const ev of stream) {
    if (ev.type === 'agent_end') final = ev.messages;
  }
  return final;
}

function toolResultOf(messages: AgentMessage[]): ToolResultMessage | undefined {
  return messages.find((m): m is ToolResultMessage => m.role === 'toolResult');
}

describe('agent-loop per-tool timeout', () => {
  it('a tool that never resolves degrades to an isError result and the loop continues', async () => {
    const tool = baseTool({ timeoutMs: 30 });
    const messages = await run(makeConfig(toolCallThenStop('slow')), [tool]);

    const result = toolResultOf(messages);
    expect(result).toBeDefined();
    expect(result!.isError).toBe(true);
    expect(result!.content).toContain('timed out');
    // The loop went back to the LLM after the timeout (second turn ran).
    const last = messages[messages.length - 1];
    expect(last.role).toBe('assistant');
  });

  it('a tool with its own timeoutMs gets that budget instead of the default', async () => {
    let sawBudget = false;
    const tool = baseTool({
      timeoutMs: 40,
      execute: () =>
        new Promise((resolve) => {
          // Resolves within the custom budget — must NOT be timed out.
          setTimeout(() => {
            sawBudget = true;
            resolve({ content: [{ type: 'text', text: 'made it' }] });
          }, 10);
        }),
    });
    const messages = await run(makeConfig(toolCallThenStop('slow')), [tool]);
    const result = toolResultOf(messages);
    expect(sawBudget).toBe(true);
    expect(result!.isError).toBe(false);
    expect(result!.content).toBe('made it');
  });

  it('an abort mid-execute ends the turn instead of hanging forever', async () => {
    const controller = new AbortController();
    const tool = baseTool({
      execute: () => {
        // Abort AFTER the tool has started running — the old loop only checked
        // the signal between tools, so this used to hang until the tool resolved.
        setTimeout(() => controller.abort(), 10);
        return new Promise(() => {});
      },
    });
    const messages = await run(makeConfig(toolCallThenStop('slow'), controller.signal), [tool]);
    const result = toolResultOf(messages);
    expect(result).toBeDefined();
    expect(result!.isError).toBe(true);
  });

  it('default budget is two minutes', () => {
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBe(120_000);
  });
});

// P0 fix wave 2026-08-16: a crash anywhere in the loop (compaction over
// null content, convertToLlm, a decorator throwing outside
// executeToolBounded) used to emit agent_end with the PRE-turn message
// snapshot — deleting the user's prompt from LLM history while the UI kept
// showing it, and pointing Retry's rewind at the PREVIOUS exchange.
describe('agentLoop crash containment', () => {
  it('a loop crash preserves the prompt and appends an error tail instead of rolling back the turn', async () => {
    const state = {
      systemPrompt: 'sys',
      messages: [] as AgentMessage[],
      tools: [] as AgentTool[],
    };
    const config = {
      model: { id: 'x', name: 'x', provider: 'test' },
      streamFn: (() => {
        throw new Error('never reached');
      }) as never,
      convertToLlm: () => {
        throw new Error('boom in convert');
      },
    } as unknown as AgentLoopConfig;

    const prompts: AgentMessage[] = [{ role: 'user', content: 'hello', timestamp: 1 } as AgentMessage];
    const stream = agentLoop(config, state, prompts);
    let final: AgentMessage[] = [];
    for await (const ev of stream) {
      if (ev.type === 'agent_end') final = ev.messages;
    }

    expect(final.some((m) => m.role === 'user' && m.content === 'hello')).toBe(true);
    const tail = final[final.length - 1];
    expect(tail.role).toBe('assistant');
    expect((tail as { stopReason?: string }).stopReason).toBe('error');
    expect((tail as { errorMessage?: string }).errorMessage).toContain('boom in convert');
    expect(state.messages).toBe(final); // state advanced — not the pre-turn snapshot
  });
});

/** First LLM turn issues `call`; second turn stops cleanly. */
function callThenStop(call: {
  name: string;
  arguments: Record<string, unknown>;
  rawArguments?: string;
}): StreamFn {
  let n = 0;
  return () => {
    const s = new AssistantMessageEventStream();
    s.push({ type: 'start' });
    n++;
    if (n === 1) {
      s.push({
        type: 'done',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 't1', ...call }],
          stopReason: 'toolUse',
          timestamp: 1,
        },
      });
    } else {
      s.push({
        type: 'done',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          stopReason: 'stop',
          timestamp: 2,
        },
      });
    }
    return s;
  };
}

describe('agent-loop tool-argument validation', () => {
  // Before this, the loop handed whatever the model emitted straight to
  // `tool.execute`. A malformed call ran and blew up inside the tool with a
  // JS-internal message ("Cannot read properties of undefined") that the model
  // could not act on — and for permissive tools it acted on garbage instead.
  it('refuses a call missing a required argument, without executing the tool', async () => {
    let executed = false;
    const tool = baseTool({
      name: 'write',
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      execute: async () => {
        executed = true;
        return { content: [{ type: 'text', text: 'wrote' }] };
      },
    });

    const messages = await run(
      makeConfig(callThenStop({ name: 'write', arguments: { path: 'A.cs' } })),
      [tool],
    );
    const result = toolResultOf(messages);

    expect(executed).toBe(false);
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain('content');
  });

  // The rejection must still be a NORMAL tool result: an assistant tool_call
  // with no matching result is exactly what 400s the provider on the next send.
  it('still answers the tool call, so the tool_use/tool_result pairing holds', async () => {
    const tool = baseTool({
      name: 'write',
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      execute: async () => ({ content: [{ type: 'text', text: 'wrote' }] }),
    });

    const messages = await run(
      makeConfig(callThenStop({ name: 'write', arguments: {} })),
      [tool],
    );
    const results = messages.filter((m) => m.role === 'toolResult') as ToolResultMessage[];

    expect(results).toHaveLength(1);
    expect(results[0].toolCallId).toBe('t1');
  });

  it('refuses a call whose arguments never parsed as JSON, quoting what arrived', async () => {
    let executed = false;
    const tool = baseTool({
      name: 'write',
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      execute: async () => {
        executed = true;
        return { content: [{ type: 'text', text: 'wrote' }] };
      },
    });

    const messages = await run(
      makeConfig(
        callThenStop({ name: 'write', arguments: {}, rawArguments: '{"path":"A.cs","cont' }),
      ),
      [tool],
    );
    const result = toolResultOf(messages);

    expect(executed).toBe(false);
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain('not valid JSON');
    expect(result?.content).toContain('{"path":"A.cs","cont');
  });

  it('passes coerced arguments to the tool, but leaves history as the model wrote it', async () => {
    let seen: unknown;
    const tool = baseTool({
      name: 'read',
      parameters: Type.Object({ path: Type.String(), limit: Type.Optional(Type.Integer()) }),
      execute: async (_id, params) => {
        seen = params;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });

    const messages = await run(
      makeConfig(callThenStop({ name: 'read', arguments: { path: 'A.cs', limit: '200' } })),
      [tool],
    );

    expect((seen as { limit: unknown }).limit).toBe(200);
    const assistant = messages.find((m) => m.role === 'assistant');
    const block = (assistant as { content: { type: string; arguments?: Record<string, unknown> }[] })
      .content[0];
    expect(block.arguments?.limit).toBe('200');
  });

  it('executes a well-formed call unchanged', async () => {
    let executed = false;
    const tool = baseTool({
      name: 'write',
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      execute: async () => {
        executed = true;
        return { content: [{ type: 'text', text: 'wrote' }] };
      },
    });

    const messages = await run(
      makeConfig(callThenStop({ name: 'write', arguments: { path: 'A.cs', content: 'x' } })),
      [tool],
    );

    expect(executed).toBe(true);
    expect(toolResultOf(messages)?.isError).toBe(false);
  });
});

describe('agent-loop tool-result content', () => {
  // `AgentToolResult.content` is `(TextContent | ImageContent)[]`, but the loop
  // keeps only text when building the message the MODEL sees. No tool returns an
  // image today, so this is a trap for the next one (a Unity scene screenshot)
  // rather than a live bug — pinned here so the drop is a deliberate decision.
  it('drops image blocks from the tool result the model sees (known limitation)', async () => {
    const tool = baseTool({
      name: 'shot',
      parameters: Type.Object({}),
      execute: async () => ({
        content: [
          { type: 'text', text: 'captured' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        ],
      }),
    });

    const messages = await run(makeConfig(callThenStop({ name: 'shot', arguments: {} })), [tool]);

    expect(toolResultOf(messages)?.content).toBe('captured');
  });
});

describe('agent-loop tool cancellation', () => {
  // The loop used to just walk away from a timed-out tool's promise. The tool
  // kept running, so its write could land AFTER the model had been told the
  // call timed out and had already redone the work — a double write.
  it('aborts the tool itself when its budget expires', async () => {
    let sawAbort = false;
    const tool = baseTool({
      name: 'slow',
      timeoutMs: 20,
      execute: (_id, _params, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener('abort', () => {
            sawAbort = true;
            resolve({ content: [{ type: 'text', text: 'stopped' }] });
          });
        }),
    });

    await run(makeConfig(callThenStop({ name: 'slow', arguments: {} })), [tool]);
    expect(sawAbort).toBe(true);
  });

  it('tells the model the work may still have landed, not that it failed', async () => {
    const tool = baseTool({ name: 'slow', timeoutMs: 20, execute: () => new Promise(() => {}) });

    const messages = await run(makeConfig(callThenStop({ name: 'slow', arguments: {} })), [tool]);
    const result = toolResultOf(messages);

    expect(result?.isError).toBe(true);
    expect(result?.content).toContain('cancelled');
    expect(result?.content).toMatch(/may still complete/i);
  });

  it('propagates a loop-level abort to the running tool', async () => {
    let sawAbort = false;
    const controller = new AbortController();
    const tool = baseTool({
      name: 'slow',
      timeoutMs: 5_000,
      execute: (_id, _params, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener('abort', () => {
            sawAbort = true;
            resolve({ content: [{ type: 'text', text: 'stopped' }] });
          });
          setTimeout(() => controller.abort(), 10);
        }),
    });

    await run(makeConfig(callThenStop({ name: 'slow', arguments: {} }), controller.signal), [tool]);
    expect(sawAbort).toBe(true);
  });
});
