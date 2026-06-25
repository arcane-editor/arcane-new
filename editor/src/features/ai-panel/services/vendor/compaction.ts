// No-LLM context compaction (restores the compaction PI ships upstream, which
// this fork had dropped). Weak/cheap models drift and cost balloons when the
// message history grows unbounded — and the compile-gate's repair turns make
// that worse. We elide rather than summarize: summarizing busts the KV cache,
// elision preserves the stable prefix.
//
// Two elision rules, applied above an 80%-of-context-window trigger:
//  1. Microcompaction (Claude-Code): replace stale, non-read tool outputs older
//     than the last few turns with a tiny placeholder.
//  2. File-read dedup (Cline): keep only the newest `read` result per path;
//     supersede older reads of the same file.
//
// Invariants:
//  - Messages are NEVER deleted, only their `content` is shrunk — so every
//    assistant tool_call keeps its matching tool result (the OpenAI request
//    400s on an orphaned pair, see arcane-stream.ts convertToOpenAI).
//  - Open repair tasks (compile/analyzer diagnostics) are never cleared.
//  - The original array is not mutated; callers keep it as the full record and
//    send only the returned, compacted view to the LLM.

import type { AgentMessage, TextContent, ImageContent } from './types';

const CHARS_PER_TOKEN = 3.5;
const DEFAULT_TRIGGER_RATIO = 0.8;
/** Tool results within this many recent assistant turns are kept verbatim. */
const KEEP_RECENT_TURNS = 3;

const CLEARED_MARKER = '[Tool result cleared to save context]';
const STALE_READ_PREFIX = '[Stale read superseded by a newer read of ';
/** Tool-result content carrying these is an open repair task — never elide it. */
const REPAIR_SENTINELS = ['[Unity compile]', '[Unity analyzers]'];

function blockChars(b: TextContent | ImageContent): number {
  return b.type === 'text' ? b.text.length : b.data.length;
}

function contentChars(content: string | (TextContent | ImageContent)[]): number {
  if (typeof content === 'string') return content.length;
  return content.reduce((n, b) => n + blockChars(b), 0);
}

function messageChars(m: AgentMessage): number {
  switch (m.role) {
    case 'user':
    case 'toolResult':
      return contentChars(m.content);
    case 'assistant':
      return m.content.reduce((n, b) => {
        if (b.type === 'text') return n + b.text.length;
        if (b.type === 'thinking') return n + b.thinking.length;
        if (b.type === 'toolCall') return n + b.name.length + JSON.stringify(b.arguments).length;
        return n;
      }, 0);
    case 'bashExecution':
      return m.command.length + m.output.length;
    default:
      return 0;
  }
}

export function estimateTokens(messages: AgentMessage[]): number {
  let chars = 0;
  for (const m of messages) chars += messageChars(m);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function hasRepairSentinel(content: string | (TextContent | ImageContent)[]): boolean {
  const text =
    typeof content === 'string'
      ? content
      : content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  return REPAIR_SENTINELS.some((s) => text.includes(s));
}

/**
 * Return a compacted view of `messages` for sending to the LLM. Below the
 * trigger threshold the input is returned unchanged (zero overhead, stable
 * prefix preserved).
 */
export function compactMessages(
  messages: AgentMessage[],
  opts: { contextWindow: number; triggerRatio?: number },
): AgentMessage[] {
  const triggerRatio = opts.triggerRatio ?? DEFAULT_TRIGGER_RATIO;
  if (estimateTokens(messages) <= opts.contextWindow * triggerRatio) {
    return messages;
  }

  // Map every read tool_call id → its file path (from the preceding assistant
  // messages), so we can dedup read results by path.
  const pathByCallId = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const b of m.content) {
      if (b.type === 'toolCall' && b.name === 'read') {
        const p = (b.arguments as { path?: string }).path;
        if (typeof p === 'string') pathByCallId.set(b.id, p);
      }
    }
  }

  // Latest read-result index per path → everything earlier for that path is stale.
  const latestReadIdxByPath = new Map<string, number>();
  messages.forEach((m, i) => {
    if (m.role === 'toolResult' && m.toolName === 'read') {
      const p = pathByCallId.get(m.toolCallId);
      if (p) latestReadIdxByPath.set(p, i);
    }
  });

  // "Old" = before the start of the most recent KEEP_RECENT_TURNS assistant turns.
  let assistantSeen = 0;
  let oldCutoff = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      assistantSeen++;
      if (assistantSeen >= KEEP_RECENT_TURNS) {
        oldCutoff = i;
        break;
      }
    }
  }

  return messages.map((m, i) => {
    if (m.role !== 'toolResult') return m;
    if (hasRepairSentinel(m.content)) return m;

    if (m.toolName === 'read') {
      const p = pathByCallId.get(m.toolCallId);
      if (p && latestReadIdxByPath.get(p) !== i) {
        return { ...m, content: `${STALE_READ_PREFIX}${p}]` };
      }
      return m; // newest read of this file — keep it
    }

    // Non-read tool output: clear if it's old.
    if (i < oldCutoff) return { ...m, content: CLEARED_MARKER };
    return m;
  });
}
