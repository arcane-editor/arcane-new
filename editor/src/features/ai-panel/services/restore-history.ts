/**
 * Rebuilding LLM history from a saved transcript.
 *
 * **Why this needs to pair tool calls with their results.** A provider rejects
 * a history containing an assistant turn that called a tool with no result
 * following it — and it rejects it deterministically, so the client's retry
 * loop cannot help: the turn sits on "Thinking…" through the backoff and ends
 * as the server's generic `model_error`, surfaced as a bare "Server error"
 * that names nothing.
 *
 * An interrupted turn leaves exactly that. A Stop mid-tool, a crash, or a
 * blocked `ask_user` that never got answered all save an assistant message
 * whose `toolCall` block has no `toolResult` after it. `settleDanglingRequests`
 * already repairs the UI side of this (it marks the question cancelled), but
 * the question card is UI-only — the orphaned CALL is still in the history.
 *
 * This went unnoticed for as long as it did because resuming was rare: the AI
 * panel only rebuilds history when you deliberately open a session from
 * History. The design dock resumes its document's thread on EVERY send, so one
 * interrupted turn poisoned that thread permanently — every later send failed,
 * and only in that chat.
 *
 * Pure and DOM-free, so the pairing rules are directly testable under Bun;
 * `agent-service.ts` itself is not (Global Constraint 4).
 */

import type { AiMessage } from '../../../stores/ai';
import type { AgentMessage } from './vendor/types';

/** Ids of tool calls the transcript actually has a result for. */
function answeredToolCallIds(messages: readonly AiMessage[]): Set<string> {
  const out = new Set<string>();
  for (const m of messages) {
    if (m.role === 'toolResult' && m.toolCallId) out.add(m.toolCallId);
  }
  return out;
}

/**
 * Convert saved UI messages back into vendor `AgentMessage`s for resume.
 *
 * Drops both halves of a broken pair: a tool call with no result, and a result
 * with no call. Either one alone is a malformed history.
 *
 * `system` / `permissionRequest` / `questionRequest` / `verifiedPass` / `error`
 * / `stopped` are not part of LLM history and are skipped. (`ask_user`'s answer
 * is the tool call's own `toolResult`, restored below; the questionRequest
 * message is UI-only, as is `stopped` — resuming re-sends fresh text, it never
 * replays as if the model said it.)
 */
export function restoreAgentMessages(messages: AiMessage[]): AgentMessage[] {
  const answered = answeredToolCallIds(messages);
  const called = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const block of m.content ?? []) {
      if (block.type === 'toolCall') called.add(block.id);
    }
  }

  const out: AgentMessage[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.text ?? '', timestamp: m.timestamp });
    } else if (m.role === 'assistant') {
      const content = m.content ?? [];
      const kept = content.filter((b) => b.type !== 'toolCall' || answered.has(b.id));
      // An assistant turn that was ONLY an unanswered tool call carries nothing
      // the model needs; keeping it as an empty turn is its own malformed
      // history. A turn that still has text keeps the text.
      if (content.length > 0 && kept.length === 0) continue;
      out.push({ role: 'assistant', content: kept, timestamp: m.timestamp });
    } else if (m.role === 'toolResult') {
      const id = m.toolCallId ?? '';
      // A result whose call was never recorded has nothing to attach to.
      if (!called.has(id)) continue;
      out.push({
        role: 'toolResult',
        toolCallId: id,
        toolName: m.toolName ?? '',
        content: m.toolResult?.content ?? '',
        isError: m.toolResult?.isError ?? false,
        timestamp: m.timestamp,
      });
    }
  }
  return out;
}
