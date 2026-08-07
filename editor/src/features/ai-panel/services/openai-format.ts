import type { Message, ToolCall } from './vendor/types';

export type OpenAIUserPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | OpenAIUserPart[] | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/**
 * Content blocks for a message, or `[]` when there are none.
 *
 * The `Message` types declare `content` as a non-nullable array, but the
 * runtime disagrees: a turn that errored, was aborted mid-stream, or was
 * restored from a persisted session can carry `null`. `convertToOpenAI` runs
 * before the fetch, so one such message threw "Cannot read properties of null
 * (reading 'filter')" and killed the send before it reached the network.
 */
function blocks<T>(content: T[] | null | undefined): T[] {
  return Array.isArray(content) ? content : [];
}

export function convertToOpenAI(systemPrompt: string, messages: Message[]): OpenAIMessage[] {
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
        const textParts = blocks(msg.content)
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text);
        const imageParts = blocks(msg.content)
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
        // No parts at all (content was null/empty) — send an empty string
        // rather than an empty block array, which providers reject.
        result.push({ role: 'user', content: parts.length > 0 ? parts : '' });
        break;
      }
      case 'assistant': {
        const textParts = blocks(msg.content)
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('');

        const toolCalls = blocks(msg.content)
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
            : blocks(msg.content)
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
