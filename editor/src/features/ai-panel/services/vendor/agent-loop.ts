/**
 * Core agent loop - adapted from PI coding agent (github.com/badlogic/pi-mono)
 * packages/agent/src/agent-loop.ts
 *
 * Loop: stream LLM response → check for tool calls → execute → feed back → repeat
 */

import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  AgentLoopConfig,
  AssistantMessage,
  AssistantMessageEvent,
  ToolCall,
  ToolResultMessage,
  Context,
  AgentToolResult,
} from './types';
import { EventStream } from './event-stream';
import { compactMessages } from './compaction';

/** Conservative default — the smallest model tier's window (qwen low). */
const DEFAULT_CONTEXT_WINDOW = 32768;

/**
 * Per-tool wall-clock budget (overridable via `AgentTool.timeoutMs`). A tool
 * that never resolves used to freeze the loop with no event, no error, and a
 * Stop button that couldn't reach it — the signal was only checked BETWEEN
 * tools. Now execution races the budget and the abort signal, and a breach
 * degrades to an isError result the loop continues past.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

/**
 * Race a tool execution against its timeout and the loop's abort signal.
 * The losing `execute` promise is left running (its work may still land),
 * but the LOOP moves on — that is the whole point.
 */
function executeToolBounded(
  tool: AgentTool,
  toolCall: ToolCall,
  signal: AbortSignal | undefined,
  onUpdate: (partialResult: AgentToolResult) => void,
): Promise<AgentToolResult> {
  const budgetMs = tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  return new Promise<AgentToolResult>((resolve, reject) => {
    let settled = false;
    let onAbort: (() => void) | null = null;
    // `timeoutMs: Infinity` opts a tool out of the budget entirely — used by
    // tools that legitimately wait on a HUMAN (write/edit approval, ask_user,
    // approval-gated Unity mutations). Those still race the abort signal, so
    // Stop always works; they just never spuriously "time out" while the user
    // is thinking. Note: setTimeout coerces non-finite delays to ~1ms, so the
    // skip must be explicit.
    const timer = Number.isFinite(budgetMs)
      ? setTimeout(() => {
          settle(() =>
            reject(new Error(`Tool "${toolCall.name}" timed out after ${Math.round(budgetMs / 1000)}s`)),
          );
        }, budgetMs)
      : null;

    function settle(fn: () => void): void {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      fn();
    }

    if (signal) {
      onAbort = () => settle(() => reject(new Error(`Tool "${toolCall.name}" aborted`)));
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    tool.execute(toolCall.id, toolCall.arguments, signal, onUpdate).then(
      (result) => settle(() => resolve(result)),
      (error) => settle(() => reject(error)),
    );
  });
}

type AgentLoopEventStream = EventStream<AgentEvent, AgentMessage[]>;

/**
 * Run the agent loop with initial prompt messages.
 * Returns an async iterable of AgentEvents.
 */
export function agentLoop(
  config: AgentLoopConfig,
  state: { systemPrompt: string; messages: AgentMessage[]; tools: AgentTool[] },
  prompts: AgentMessage[],
): AgentLoopEventStream {
  const stream = new EventStream<AgentEvent, AgentMessage[]>(
    (event) => event.type === 'agent_end',
    (event) => (event.type === 'agent_end' ? event.messages : []),
  );

  runLoop(config, state, prompts, stream).catch((error) => {
    console.error('Agent loop error:', error);
    stream.push({ type: 'agent_end', messages: state.messages });
  });

  return stream;
}

async function runLoop(
  config: AgentLoopConfig,
  state: { systemPrompt: string; messages: AgentMessage[]; tools: AgentTool[] },
  prompts: AgentMessage[],
  stream: AgentLoopEventStream,
): Promise<void> {
  const allMessages = [...state.messages];
  const newMessages: AgentMessage[] = [];

  stream.push({ type: 'agent_start' });

  // Add prompt messages to context
  for (const prompt of prompts) {
    allMessages.push(prompt);
    newMessages.push(prompt);
    stream.push({ type: 'message_start', message: prompt });
    stream.push({ type: 'message_end', message: prompt });
  }

  // Main agent loop
  try {
    while (true) {
      if (config.signal?.aborted) break;

      stream.push({ type: 'turn_start' });

      // 1. Stream assistant response from LLM.
      // `allMessages` stays the full record (saved/displayed); the LLM only sees a
      // compacted view so weak-model context never grows unbounded.
      const visible = compactMessages(allMessages, {
        contextWindow: config.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      });
      const assistantMessage = await streamAssistantResponse(
        config,
        { systemPrompt: state.systemPrompt, messages: visible, tools: state.tools },
        stream,
      );

      allMessages.push(assistantMessage);
      newMessages.push(assistantMessage);

      // 2. Check stop conditions
      if (assistantMessage.stopReason === 'error' || assistantMessage.stopReason === 'aborted') {
        stream.push({ type: 'turn_end' });
        break;
      }

      // 3. Extract tool calls from response
      const toolCalls = assistantMessage.content.filter(
        (c): c is ToolCall => c.type === 'toolCall',
      );

      if (toolCalls.length === 0) {
        stream.push({ type: 'turn_end' });
        break; // No tool calls = agent is done
      }

      // 4. Execute tool calls sequentially
      for (const toolCall of toolCalls) {
        if (config.signal?.aborted) break;

        const tool = state.tools.find((t) => t.name === toolCall.name);
        if (!tool) {
          const errorResult: ToolResultMessage = {
            role: 'toolResult',
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: `Error: Unknown tool "${toolCall.name}"`,
            isError: true,
            timestamp: Date.now(),
          };
          allMessages.push(errorResult);
          newMessages.push(errorResult);
          stream.push({ type: 'message_start', message: errorResult });
          stream.push({ type: 'message_end', message: errorResult });
          continue;
        }

        stream.push({
          type: 'tool_execution_start',
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          args: toolCall.arguments as Record<string, unknown>,
        });

        let result: AgentToolResult;
        let isError = false;

        try {
          result = await executeToolBounded(tool, toolCall, config.signal, (partialResult) => {
            stream.push({
              type: 'tool_execution_update',
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              result: partialResult,
            });
          });
        } catch (error) {
          isError = true;
          result = {
            content: [
              { type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` },
            ],
          };
        }

        stream.push({
          type: 'tool_execution_end',
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          result,
          isError,
        });

        // Build tool result message
        const toolResultContent = result.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('\n');

        const toolResultMessage: ToolResultMessage = {
          role: 'toolResult',
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: toolResultContent || '(empty result)',
          isError,
          timestamp: Date.now(),
        };

        allMessages.push(toolResultMessage);
        newMessages.push(toolResultMessage);
        stream.push({ type: 'message_start', message: toolResultMessage });
        stream.push({ type: 'message_end', message: toolResultMessage });
      }

      stream.push({ type: 'turn_end' });
      // Loop back to stream next assistant response
    }
  } catch (error) {
    // A crash anywhere in the loop (compaction, convertToLlm, a decorator
    // throwing outside executeToolBounded) must not roll the turn out of
    // history: the old handler emitted agent_end with the PRE-turn snapshot,
    // deleting the user's prompt from LLM history while the UI kept showing
    // it — and Retry's rewind then truncated the PREVIOUS exchange. Append
    // an error tail in the same shape a streamFn error produces and finish
    // normally with everything accumulated so far.
    const message = error instanceof Error ? error.message : String(error);
    const crashTail: AssistantMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: `Agent loop crashed: ${message}`,
      timestamp: Date.now(),
    };
    allMessages.push(crashTail);
    newMessages.push(crashTail);
    stream.push({ type: 'message_start', message: crashTail });
    stream.push({ type: 'message_end', message: crashTail });
    stream.push({ type: 'turn_end' });
  }

  // Update state with accumulated messages
  state.messages = allMessages;
  stream.push({ type: 'agent_end', messages: allMessages });
}

/**
 * Stream an assistant response from the LLM.
 */
async function streamAssistantResponse(
  config: AgentLoopConfig,
  context: { systemPrompt: string; messages: AgentMessage[]; tools: AgentTool[] },
  eventStream: AgentLoopEventStream,
): Promise<AssistantMessage> {
  const llmMessages = config.convertToLlm(context.messages);

  const llmContext: Context = {
    systemPrompt: context.systemPrompt,
    messages: llmMessages,
    tools: context.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  };

  const stream = config.streamFn(llmContext, {
    model: config.model,
    signal: config.signal,
    reasoning: config.reasoning,
  });

  let currentMessage: AssistantMessage = {
    role: 'assistant',
    content: [],
    timestamp: Date.now(),
  };

  eventStream.push({ type: 'message_start', message: currentMessage });

  for await (const event of stream) {
    currentMessage = updateAssistantMessage(currentMessage, event);

    if (event.type === 'done') {
      currentMessage = event.message;
    } else if (event.type === 'error') {
      currentMessage = event.partial ?? {
        ...currentMessage,
        stopReason: 'error',
        errorMessage: event.error.message,
      };
    } else {
      eventStream.push({ type: 'message_update', message: currentMessage });
    }
  }

  eventStream.push({ type: 'message_end', message: currentMessage });
  return currentMessage;
}

/**
 * Incrementally update an in-progress assistant message with a stream event.
 */
function updateAssistantMessage(
  msg: AssistantMessage,
  event: AssistantMessageEvent,
): AssistantMessage {
  const content = [...msg.content];

  switch (event.type) {
    case 'text_start':
      content.push({ type: 'text', text: '' });
      break;
    case 'text_delta': {
      const last = content[content.length - 1];
      if (last?.type === 'text') {
        content[content.length - 1] = { ...last, text: last.text + event.text };
      }
      break;
    }
    case 'thinking_start':
      content.push({ type: 'thinking', thinking: '' });
      break;
    case 'thinking_delta': {
      const last = content[content.length - 1];
      if (last?.type === 'thinking') {
        content[content.length - 1] = { ...last, thinking: last.thinking + event.thinking };
      }
      break;
    }
    case 'toolcall_start':
      content.push({ type: 'toolCall', id: event.id, name: event.name, arguments: {} });
      break;
    case 'toolcall_delta': {
      const last = content[content.length - 1];
      if (last?.type === 'toolCall') {
        const existing = (last as any)._rawArgs ?? '';
        const raw = existing + event.arguments;
        try {
          const parsed = JSON.parse(raw);
          content[content.length - 1] = { ...last, arguments: parsed };
        } catch {
          // Partial JSON — keep raw for next delta
          content[content.length - 1] = { ...last };
          (content[content.length - 1] as any)._rawArgs = raw;
        }
      }
      break;
    }
    default:
      return msg;
  }

  return { ...msg, content };
}
