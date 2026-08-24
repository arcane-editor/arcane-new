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
import { compactMessages, estimateReservedTokens } from './compaction';
import { validateToolArgs } from './tools/validate-args';

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
 *
 * Each call gets its OWN `AbortController`, chained to the loop's signal. The
 * loop used to simply walk away from the losing promise — the tool kept
 * running, so a write could land on disk *after* the model had been told the
 * call timed out and had already redone the work. Now the budget expiring
 * actually cancels the call for every tool that observes its signal.
 *
 * A tool that ignores its signal still cannot be stopped, so the timeout
 * message says so rather than implying the work definitely failed.
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
    /** Per-call cancellation, so a timeout can reach the tool itself. */
    const callAbort = new AbortController();
    // `timeoutMs: Infinity` opts a tool out of the budget entirely — used by
    // tools that legitimately wait on a HUMAN (write/edit approval, ask_user,
    // approval-gated Unity mutations). Those still race the abort signal, so
    // Stop always works; they just never spuriously "time out" while the user
    // is thinking. Note: setTimeout coerces non-finite delays to ~1ms, so the
    // skip must be explicit.
    const timer = Number.isFinite(budgetMs)
      ? setTimeout(() => {
          callAbort.abort();
          settle(() =>
            reject(
              new Error(
                `Tool "${toolCall.name}" timed out after ${Math.round(budgetMs / 1000)}s and was ` +
                  `cancelled. Work it had already started may still complete — check the current ` +
                  `state before retrying rather than assuming nothing happened.`,
              ),
            ),
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
      onAbort = () => {
        callAbort.abort();
        settle(() => reject(new Error(`Tool "${toolCall.name}" aborted`)));
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    tool.execute(toolCall.id, toolCall.arguments, callAbort.signal, onUpdate).then(
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
        // The system prompt and the tool schemas ride on every request. Leaving
        // them out of the budget let a send pass 100% of the window while
        // compaction believed it was at 79% of it.
        reservedTokens: estimateReservedTokens(state.systemPrompt, state.tools),
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

        // Nothing used to check the call against the schema the tool declares,
        // so a malformed call ran anyway and failed deep inside the tool with a
        // JS-internal message the model could not act on. Reject it here, in the
        // shape of an ordinary tool result — which keeps the tool_use/tool_result
        // pairing intact (an unanswered call 400s the provider on the next send)
        // and gives the model a correction it can apply.
        const validated = validateToolArgs(
          tool.name,
          tool.parameters,
          toolCall.arguments,
          toolCall.rawArguments,
        );

        if (!validated.ok) {
          isError = true;
          result = { content: [{ type: 'text', text: validated.message }] };
        } else {
          // Execute with the coerced value, but leave the assistant message
          // holding exactly what the model produced.
          const call = { ...toolCall, arguments: validated.value };
          try {
            result = await executeToolBounded(tool, call, config.signal, (partialResult) => {
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
        // Accumulate on the typed `rawArguments` field. This used to stash the
        // partial blob on an `any`-cast `_rawArgs` property that was MUTATED
        // onto the content block, so it rode along into the persisted session
        // transcript and into `convertToLlm`. The accumulator is also the
        // authoritative record when the blob never becomes valid JSON — the
        // loop refuses such a call rather than running it on `{}`.
        const raw = (last.rawArguments ?? '') + event.arguments;
        try {
          const parsed = JSON.parse(raw);
          content[content.length - 1] =
            parsed !== null && typeof parsed === 'object'
              ? { ...last, arguments: parsed as Record<string, unknown>, rawArguments: undefined }
              : { ...last, rawArguments: raw };
        } catch {
          // Partial JSON — keep the raw text for the next delta.
          content[content.length - 1] = { ...last, rawArguments: raw };
        }
      }
      break;
    }
    default:
      return msg;
  }

  return { ...msg, content };
}
