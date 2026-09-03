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
//    400s on an orphaned pair, see hosted-stream.ts convertToOpenAI).
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
const REPAIR_SENTINELS = [
  '[Unity compile]',
  '[Unity analyzers]',
  // The asset gate's four labels (`asset-checks.ts`'s `gateLabelFor`). A
  // repair instruction elided under compaction is a repair that never
  // happens, and these formats fail silently in Unity rather than loudly.
  '[Unity UXML]',
  '[Unity USS]',
  '[Unity input actions]',
  '[Unity asset]',
];

/**
 * Flat char-equivalent for an image block. Counting the base64 payload as
 * text overshot real vision token cost ~1000x — one pasted screenshot pinned
 * every later send above the compaction trigger, and since compaction only
 * elides tool results (never the image) the model lost its own bash/compile
 * outputs for the rest of the session. Vision models bill an image at
 * roughly 1–2k tokens; 2k tokens' worth of chars is a safe over-estimate.
 */
const IMAGE_CHARS_ESTIMATE = 2000 * CHARS_PER_TOKEN;

function blockChars(b: TextContent | ImageContent): number {
  return b.type === 'text' ? b.text.length : IMAGE_CHARS_ESTIMATE;
}

function contentChars(content: string | (TextContent | ImageContent)[] | null | undefined): number {
  // Aborted/restored turns can carry null content at runtime (see
  // openai-format.ts) — a throw here crashed the whole loop every turn.
  if (content == null) return 0;
  if (typeof content === 'string') return content.length;
  return content.reduce((n, b) => n + blockChars(b), 0);
}

function messageChars(m: AgentMessage): number {
  switch (m.role) {
    case 'user':
    case 'toolResult':
      return contentChars(m.content);
    case 'assistant':
      return (m.content ?? []).reduce((n, b) => {
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
 * Smallest budget we will ever compact toward. Without a floor, a system prompt
 * larger than the window produces a zero or negative budget and every message
 * gets shredded to nothing.
 */
const MIN_BUDGET_TOKENS = 4096;
/** Characters left on a message when the last-resort text truncation runs. */
const TRUNCATE_KEEP_CHARS = [400, 80];
const TRUNCATED_SUFFIX = ' […truncated to fit context]';
const IMAGE_SHED_MARKER = '[image removed to fit context]';

export interface CompactionOptions {
  contextWindow: number;
  triggerRatio?: number;
  /**
   * Tokens the request spends before a single message is counted: the system
   * prompt (Unity facts + context pack + graph snapshot) and every tool's JSON
   * schema. Compaction used to ignore both while comparing against 80% of the
   * FULL window, so a request could pass 100% of the window while compaction
   * believed it sat at 79%.
   */
  reservedTokens?: number;
}

/** Token cost of everything that rides on a request besides the messages. */
export function estimateReservedTokens(
  systemPrompt: string,
  tools: ReadonlyArray<{ name: string; description: string; parameters: unknown }>,
): number {
  let chars = systemPrompt.length;
  for (const t of tools) {
    chars += t.name.length + t.description.length;
    try {
      chars += JSON.stringify(t.parameters)?.length ?? 0;
    } catch {
      // A non-serializable schema is not worth crashing a send over.
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Return a compacted view of `messages` for sending to the LLM. Below the
 * trigger threshold the input is returned unchanged (zero overhead, stable
 * prefix preserved).
 *
 * Above it, elision escalates in stages and RE-CHECKS after each one. The old
 * implementation ran a single stage that could only shrink tool results, then
 * returned whatever it had — so a conversation whose weight was user text,
 * attachments or assistant prose came back still over the window, and nothing
 * noticed. The send then died at the provider with a context-length rejection.
 *
 * Every stage shrinks `content` in place; no stage ever removes a message, so
 * the tool_call ↔ tool_result pairing this file has always guaranteed still
 * holds at the end (an orphaned pair 400s the request).
 */
export function compactMessages(
  messages: AgentMessage[],
  opts: CompactionOptions,
): AgentMessage[] {
  const budget = Math.max(opts.contextWindow - (opts.reservedTokens ?? 0), MIN_BUDGET_TOKENS);
  const triggerRatio = opts.triggerRatio ?? DEFAULT_TRIGGER_RATIO;

  if (estimateTokens(messages) <= budget * triggerRatio) {
    return messages;
  }

  let out = elideStaleToolResults(messages);
  if (estimateTokens(out) <= budget) return out;

  out = clearAllButNewestToolResults(out);
  if (estimateTokens(out) <= budget) return out;

  out = shedImages(out);
  if (estimateTokens(out) <= budget) return out;

  return truncateOldestText(out, budget);
}

/**
 * Stage 1 (unchanged behaviour): microcompaction of stale non-`read` tool
 * output, plus file-read dedup by path.
 */
function elideStaleToolResults(messages: AgentMessage[]): AgentMessage[] {
  // Map every read tool_call id → its file path (from the preceding assistant
  // messages), so we can dedup read results by path.
  const pathByCallId = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const b of m.content ?? []) {
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

/**
 * Stage 2: clear EVERY tool result except those belonging to the most recent
 * assistant turn — the model just called those and still needs to read them.
 * Open repair tasks stay verbatim; they are the whole point of the next turn.
 */
function clearAllButNewestToolResults(messages: AgentMessage[]): AgentMessage[] {
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }

  return messages.map((m, i) => {
    if (m.role !== 'toolResult') return m;
    if (i > lastAssistantIdx) return m;
    if (hasRepairSentinel(m.content)) return m;
    if (m.content === CLEARED_MARKER) return m;
    return { ...m, content: CLEARED_MARKER };
  });
}

/**
 * Stage 3: drop image payloads. `IMAGE_CHARS_ESTIMATE` keeps an image from
 * dominating the ESTIMATE, but an image still costs real tokens on the wire and
 * compaction had no way to shed one — so a conversation carrying several
 * screenshots could not be brought under any budget. The newest message keeps
 * its images (it is likely what the user just asked about).
 */
function shedImages(messages: AgentMessage[]): AgentMessage[] {
  const last = messages.length - 1;
  return messages.map((m, i) => {
    if (i === last) return m;
    if (m.role !== 'user' || !Array.isArray(m.content)) return m;
    if (!m.content.some((b) => b.type === 'image')) return m;
    return {
      ...m,
      content: m.content.map((b) =>
        b.type === 'image' ? { type: 'text' as const, text: IMAGE_SHED_MARKER } : b,
      ),
    };
  });
}

function truncateText(text: string, keep: number): string {
  return text.length <= keep ? text : text.slice(0, keep) + TRUNCATED_SUFFIX;
}

/** Shrink one message's text, leaving `toolCall` blocks (and ids) untouched. */
function shrinkMessage(m: AgentMessage, keep: number): AgentMessage {
  switch (m.role) {
    case 'user':
      if (typeof m.content === 'string') return { ...m, content: truncateText(m.content, keep) };
      if (!Array.isArray(m.content)) return m;
      return {
        ...m,
        content: m.content.map((b) =>
          b.type === 'text' ? { ...b, text: truncateText(b.text, keep) } : b,
        ),
      };
    case 'toolResult':
      if (typeof m.content !== 'string') return m;
      return { ...m, content: truncateText(m.content, keep) };
    case 'assistant':
      return {
        ...m,
        content: (m.content ?? []).map((b) => {
          if (b.type === 'text') return { ...b, text: truncateText(b.text, keep) };
          if (b.type === 'thinking') return { ...b, thinking: truncateText(b.thinking, keep) };
          return b; // toolCall — never touched, the pairing depends on it
        }),
      };
    case 'bashExecution':
      return { ...m, output: truncateText(m.output, keep) };
    default:
      return m;
  }
}

/**
 * Stage 4, last resort: head-truncate the oldest messages until the whole thing
 * fits. The NEWEST message is never touched — it is the turn being answered.
 */
function truncateOldestText(messages: AgentMessage[], budget: number): AgentMessage[] {
  const out = [...messages];
  for (const keep of TRUNCATE_KEEP_CHARS) {
    for (let i = 0; i < out.length - 1; i++) {
      if (estimateTokens(out) <= budget) return out;
      out[i] = shrinkMessage(out[i], keep);
    }
    if (estimateTokens(out) <= budget) return out;
  }
  return out;
}
