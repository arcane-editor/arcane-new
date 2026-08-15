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
