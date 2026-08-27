/**
 * working-indicator — where the "agent is working" dots belong in the
 * transcript. Pure, so the placement rule is testable without mounting the
 * message list (same split as `question-routing.ts`).
 *
 * THE RULE: the dots live at the TAIL of the transcript, always. They mean
 * "something is still coming", and something still coming arrives at the
 * bottom.
 *
 * They used to be rendered unconditionally inside any streaming assistant
 * message (`AssistantMessage`: `{message.isStreaming && <StreamingIndicator/>}`),
 * which holds only while that message IS the tail. The moment the agent
 * appended anything after it — a question card, a permission request — the
 * dots were stranded ABOVE the new block, pointing at finished output while
 * the live thing sat underneath them. A streaming message keeps `isStreaming`
 * until its own `message_end`, so an `ask_user` call raised mid-message left
 * them there for as long as the user took to answer, and after answering too.
 *
 * So: inline dots only while that message is last, and a standalone tail row
 * for every other running state — except while the agent is blocked on the
 * user, where "working" would be a lie and the card itself is the thing to
 * look at.
 */

import type { AiMessage } from '../../../stores/ai';

/**
 * True while the transcript's last block is one the USER has to act on, so the
 * agent is parked rather than working. Covers both gates that can end a
 * transcript this way: an unanswered `ask_user` question and an unresolved
 * permission request.
 */
export function isAwaitingUser(last: AiMessage | null | undefined): boolean {
  if (!last) return false;
  if (last.role === 'questionRequest') {
    const q = last.questionRequest;
    return !!q && q.resolvedAnswer === undefined && !q.cancelled;
  }
  if (last.role === 'permissionRequest') {
    const p = last.permissionRequest;
    return !!p && p.resolvedOptionId === undefined;
  }
  return false;
}

/** Dots inside an assistant bubble: only while that bubble is the tail. */
export function showsInlineIndicator(message: AiMessage, isLast: boolean): boolean {
  return !!message.isStreaming && isLast;
}

export interface TailIndicatorInput {
  isAgentRunning: boolean;
  /** The last message in the transcript, or null when it is empty. */
  last: AiMessage | null | undefined;
}

/**
 * Dots as their own row after the last message — the running states the inline
 * indicator cannot cover: a finished assistant bubble with tool calls still
 * executing, a tool result, a question the user has just answered, or a turn
 * that has started before its first message exists.
 */
export function showsTailIndicator({ isAgentRunning, last }: TailIndicatorInput): boolean {
  if (!isAgentRunning) return false;
  // A live streaming bubble at the tail already carries its own dots; a second
  // row under it would double them.
  if (last && last.role === 'assistant' && last.isStreaming) return false;
  return !isAwaitingUser(last);
}
