/**
 * Arcane server streaming integration.
 * Implements the StreamFn that replaces PI's direct provider calls
 * with calls to the Arcane Cloudflare Workers server.
 */

import { useAuthStore } from '../../../stores/auth';
import { useAiStore } from '../../../stores/ai';
import type {
  Context,
  StreamOptions,
  AssistantMessage,
  Message,
  ToolCall,
} from './vendor/types';
import { AssistantMessageEventStream } from './vendor/event-stream';

const ARCANE_SERVER_URL = 'https://api.arcaneai.org';

interface ArcaneStreamEvent {
  type: 'text' | 'tool_call' | 'thinking' | 'usage' | 'error';
  content?: string;
  id?: string;
  name?: string;
  arguments?: string;
  finished?: boolean;
  thought?: string;
  input_tokens?: number;
  output_tokens?: number;
  message?: string;
}

/**
 * StreamFn implementation that calls the Arcane server.
 * Converts PI's context format to OpenAI-compatible format,
 * streams SSE events, and converts them to PI's AssistantMessageEvent format.
 */
export function arcaneStream(
  context: Context,
  options: StreamOptions,
): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();

  doStream(context, options, stream).catch((error) => {
    stream.push({
      type: 'error',
      error: error instanceof Error ? error : new Error(String(error)),
    });
  });

  return stream;
}

async function doStream(
  context: Context,
  options: StreamOptions,
  stream: AssistantMessageEventStream,
): Promise<void> {
  const token = useAuthStore.getState().token;
  if (!token) {
    stream.push({
      type: 'error',
      error: new Error('Not logged in. Please sign in to use the AI assistant.'),
    });
    return;
  }

  // Convert PI messages to OpenAI-compatible format
  const messages = convertToOpenAI(context.systemPrompt, context.messages);

  // Convert PI tools to OpenAI function format
  const tools = context.tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  const currentMode = useAiStore.getState().mode;
  // Map the UI mode to the server's taskType enum ('chat' | 'edit' | 'plan' |
  // 'explain'). Model choice is fully backend-driven off `reasoningLevel`; this
  // is metadata for logging only.
  const taskType = currentMode === 'ask' ? 'chat' : currentMode === 'plan' ? 'plan' : 'edit';
  // Per-task output ceiling so the server clamp has a sane per-mode cap (the
  // server still clamps to the model's published max). Q&A rarely needs 8k;
  // agentic edits / plans can. Caps the output cost driver alongside compaction.
  const maxTokensByTask = { chat: 16384, plan: 24576, edit: 24576 } as const;
  const body = {
    messages,
    tools: tools.length > 0 ? tools : undefined,
    stream: true,
    max_tokens: maxTokensByTask[taskType],
    metadata: {
      taskType,
      mode: currentMode,
      reasoningLevel: options.reasoning ?? 'mid',
    },
  };

  let response: Response;
  try {
    response = await fetch(`${ARCANE_SERVER_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      stream.push({
        type: 'done',
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'aborted',
          timestamp: Date.now(),
        },
      });
      return;
    }
    throw error;
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    if (response.status === 401 || response.status === 403) {
      // Expired/revoked token: clear local auth state so the Arcane sign-in
      // gate appears and we avoid repeated unauthorized calls.
      await useAuthStore.getState().logout().catch(() => {});
      throw new Error('Authentication expired. Please log in again.');
    }
    if (response.status === 429) {
      throw new Error('Rate limit exceeded. Please wait a moment and try again.');
    }
    throw new Error(`Server error (${response.status}): ${errorText}`);
  }

  if (!response.body) {
    throw new Error('No response body');
  }

  // Emit start event
  stream.push({ type: 'start' });

  // Parse SSE stream
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let contentIndex = 0;
  let thinkingIndex = -1;
  let toolCallIndices: Map<string, number> = new Map();
  const contentBlocks: AssistantMessage['content'] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          // Stream complete
          const finalMessage: AssistantMessage = {
            role: 'assistant',
            content: contentBlocks,
            stopReason: contentBlocks.some((c) => c.type === 'toolCall') ? 'toolUse' : 'stop',
            timestamp: Date.now(),
          };
          stream.push({ type: 'done', message: finalMessage });
          return;
        }

        let event: ArcaneStreamEvent;
        try {
          event = JSON.parse(data);
        } catch {
          continue; // Skip malformed events
        }

        switch (event.type) {
          case 'text': {
            if (contentBlocks.length === 0 || contentBlocks[contentBlocks.length - 1].type !== 'text') {
              contentBlocks.push({ type: 'text', text: '' });
              stream.push({ type: 'text_start', index: contentIndex });
            }
            const textBlock = contentBlocks[contentBlocks.length - 1];
            if (textBlock.type === 'text') {
              textBlock.text += event.content ?? '';
              stream.push({ type: 'text_delta', index: contentIndex, text: event.content ?? '' });
            }
            break;
          }
          case 'thinking': {
            if (thinkingIndex === -1) {
              thinkingIndex = contentBlocks.length;
              contentBlocks.push({ type: 'thinking', thinking: '' });
              stream.push({ type: 'thinking_start', index: thinkingIndex });
            }
            const thinkBlock = contentBlocks[thinkingIndex];
            if (thinkBlock.type === 'thinking') {
              thinkBlock.thinking += event.thought ?? event.content ?? '';
              stream.push({
                type: 'thinking_delta',
                index: thinkingIndex,
                thinking: event.thought ?? event.content ?? '',
              });
            }
            break;
          }
          case 'tool_call': {
            const tcId = event.id ?? `tc_${toolCallIndices.size}`;
            if (!toolCallIndices.has(tcId)) {
              const idx = contentBlocks.length;
              toolCallIndices.set(tcId, idx);
              contentBlocks.push({
                type: 'toolCall',
                id: tcId,
                name: event.name ?? '',
                arguments: {},
              });
              stream.push({
                type: 'toolcall_start',
                index: idx,
                id: tcId,
                name: event.name ?? '',
              });
            }

            if (event.arguments) {
              const idx = toolCallIndices.get(tcId)!;
              stream.push({
                type: 'toolcall_delta',
                index: idx,
                arguments: event.arguments,
              });

              // Try to parse final arguments
              if (event.finished) {
                const block = contentBlocks[idx];
                if (block.type === 'toolCall') {
                  try {
                    block.arguments = JSON.parse(event.arguments);
                  } catch {
                    // Keep existing arguments
                  }
                }
                stream.push({ type: 'toolcall_end', index: idx });
              }
            }
            break;
          }
          case 'error': {
            stream.push({
              type: 'error',
              error: new Error(event.message ?? 'Unknown server error'),
              partial: {
                role: 'assistant',
                content: contentBlocks,
                stopReason: 'error',
                errorMessage: event.message,
                timestamp: Date.now(),
              },
            });
            return;
          }
          // 'usage' events are informational — skip for now
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // If we reach here without [DONE], finalize
  const finalMessage: AssistantMessage = {
    role: 'assistant',
    content: contentBlocks,
    stopReason: 'stop',
    timestamp: Date.now(),
  };
  stream.push({ type: 'done', message: finalMessage });
}

// ---- Message format conversion ----

type OpenAIUserPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | OpenAIUserPart[] | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

function convertToOpenAI(systemPrompt: string, messages: Message[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt });
  }

  for (const msg of messages) {
    switch (msg.role) {
      case 'user': {
        if (typeof msg.content === 'string') {
          result.push({ role: 'user', content: msg.content });
          break;
        }
        // Multi-part: emit OpenAI-style content blocks. Text blocks are
        // joined into a leading text part (preserves the prefix Inline
        // attachment context) and each image becomes its own image_url block.
        const textParts = msg.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text);
        const imageParts = msg.content
          .filter(
            (c): c is { type: 'image'; data: string; mimeType: string } =>
              c.type === 'image',
          )
          .map<OpenAIUserPart>((c) => ({
            type: 'image_url',
            image_url: { url: `data:${c.mimeType};base64,${c.data}` },
          }));
        const parts: OpenAIUserPart[] = [];
        if (textParts.length > 0) {
          parts.push({ type: 'text', text: textParts.join('\n') });
        }
        parts.push(...imageParts);
        result.push({ role: 'user', content: parts });
        break;
      }
      case 'assistant': {
        const textParts = msg.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('');

        const toolCalls = msg.content
          .filter((c): c is ToolCall => c.type === 'toolCall')
          .map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          }));

        result.push({
          role: 'assistant',
          content: textParts || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        });
        break;
      }
      case 'toolResult': {
        const content =
          typeof msg.content === 'string'
            ? msg.content
            : msg.content
                .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
                .map((c) => c.text)
                .join('\n');
        result.push({
          role: 'tool',
          tool_call_id: msg.toolCallId,
          content,
        });
        break;
      }
    }
  }

  return result;
}
