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
