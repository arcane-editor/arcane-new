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

/**
 * Repair the tool_call ↔ tool-result pairing invariant.
 *
 * An abort mid-tool-list or a mid-stream error leaves an assistant message
 * carrying `tool_calls` with no matching results (agent-loop pushes the
 * assistant message BEFORE executing tools). OpenAI-compatible providers 400
 * on the orphaned pair — which used to poison the conversation permanently:
 * every subsequent send replayed the same broken history and failed. This is
 * the same invariant `compaction.ts` documents; enforcing it only there left
 * the un-compacted path (every conversation under the trigger threshold)
 * unprotected.
 *
 * Two repairs, one forward scan:
 *  - assistant tool_calls with no result → synthesize an "[interrupted]" tool
 *    message right after the answered ones;
 *  - a tool message whose id matches no expected call at that position → drop
 *    (providers also reject results with no preceding call).
 */
function repairToolPairs(messages: OpenAIMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  /**
   * Every tool-call id handed to the provider, across the WHOLE conversation.
   * Outstanding calls used to be tracked in a per-message `Set`, so two calls
   * sharing an id collapsed to one entry: the first result deleted it, the
   * second was dropped as a stray, and the assistant message still advertised
   * two calls — an unanswered pair, which is precisely the 400 this function
   * exists to prevent, made permanent because the broken history replays on
   * every send. Duplicate ids are not hypothetical: the server's
   * `sanitizeToolCallId` normalises ids to `[A-Za-z0-9_-]`, which can flatten
   * two distinct ids into the same string.
   */
  const usedIds = new Set<string>();

  function uniqueId(id: string): string {
    if (!usedIds.has(id)) {
      usedIds.add(id);
      return id;
    }
    let n = 2;
    while (usedIds.has(`${id}_${n}`)) n++;
    const fresh = `${id}_${n}`;
    usedIds.add(fresh);
    return fresh;
  }

  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      // Give every call a distinct id, remembering the rename so its result can
      // follow. Slots are filled in arrival order, which is the only ordering
      // information a duplicated id leaves us.
      const slots = m.tool_calls.map((tc) => {
        const to = uniqueId(tc.id);
        return { from: tc.id, to, filled: false };
      });
      const renamed = slots.some((sl) => sl.from !== sl.to);
      out.push(
        renamed
          ? { ...m, tool_calls: m.tool_calls.map((tc, idx) => ({ ...tc, id: slots[idx].to })) }
          : m,
      );
      i++;

      while (i < messages.length && messages[i].role === 'tool') {
        const t = messages[i];
        const slot = slots.find((sl) => !sl.filled && sl.from === t.tool_call_id);
        if (slot) {
          slot.filled = true;
          out.push(slot.to === t.tool_call_id ? t : { ...t, tool_call_id: slot.to });
        }
        // else: stray result with no live tool_call — drop (providers reject it)
        i++;
      }

      for (const slot of slots) {
        if (slot.filled) continue;
        out.push({
          role: 'tool',
          tool_call_id: slot.to,
          content: '[interrupted — no result produced]',
        });
      }
      continue;
    }
    if (m.role === 'tool') {
      i++; // stray result with no live tool_call — drop
      continue;
    }
    out.push(m);
    i++;
  }
  return out;
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

  return repairToolPairs(result);
}
