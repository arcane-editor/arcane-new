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
  while (true) {
    if (config.signal?.aborted) break;

    stream.push({ type: 'turn_start' });

    // 1. Stream assistant response from LLM
    const assistantMessage = await streamAssistantResponse(
      config,
      { systemPrompt: state.systemPrompt, messages: allMessages, tools: state.tools },
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
        result = await tool.execute(
          toolCall.id,
          toolCall.arguments,
          config.signal,
          (partialResult) => {
            stream.push({
              type: 'tool_execution_update',
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              result: partialResult,
            });
          },
        );
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
