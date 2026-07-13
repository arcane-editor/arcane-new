/**
 * Turn-error classification + outcome-detection core (T3). Pure functions
 * only — no runtime imports (see the `import type`-only imports below), so
 * this stays Bun-testable and import-cycle-free, matching
 * `session-persistence.ts`'s pattern for reaching into `stores/ai` for a
 * type only.
 *
 * This module builds the vocabulary later tasks (T4 stores the resulting
 * `TurnError` on an assistant message; T5 renders it as an inline
 * `ErrorBlock` with Retry) consume. Nothing here touches the store or UI.
 */

import type { AgentMessage, AssistantMessage } from './vendor/types';
import type { AiMessage } from '../../../stores/ai';

export type TurnErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'server'
  | 'network'
  | 'timeout'
  | 'corrupted'
  | 'crash'
  | 'unknown';

export interface TurnError {
  kind: TurnErrorKind;
  title: string; // human headline, e.g. "Server error (502)"
  detail?: string; // one-line guidance, e.g. "This is usually temporary — try again in a moment."
  raw: string; // full original message (expandable section in the UI)
  retriable: boolean;
}

const NETWORK_SUBSTRINGS = [
  'failed to fetch',
  'load failed', // WKWebView on macOS produces "Load failed" for network errors
  'error sending request',
  'fetch failed',
  'network',
  'no response body',
];

/**
 * Classifies a raw error message (from `AssistantMessage.errorMessage` or a
 * caught exception's `.message`) into a `TurnError`. Order matters — first
 * match wins, matching the table in the T3 brief.
 */
export function classifyTurnError(raw: string): TurnError {
  const lower = raw.toLowerCase();

  if (lower.includes('authentication expired') || lower.includes('not logged in')) {
    return {
      kind: 'auth',
      title: 'Session expired',
      detail: 'You were signed out. Sign back in, then press Retry.',
      raw,
      retriable: true,
    };
  }

  if (lower.includes('rate limit')) {
    return {
      kind: 'rate_limit',
      title: 'Rate limited',
      detail: 'Too many requests — wait a moment and try again.',
      raw,
      retriable: true,
    };
  }

  const serverMatch = /^server error \((\d+)\)/i.exec(raw);
  if (serverMatch) {
    return {
      kind: 'server',
      title: `Server error (${serverMatch[1]})`,
      detail: 'This is usually temporary — try again in a moment.',
      raw,
      retriable: true,
    };
  }

  if (lower.includes('stream stalled')) {
    return {
      kind: 'timeout',
      title: 'Connection timed out',
      raw,
      retriable: true,
    };
  }

  if (NETWORK_SUBSTRINGS.some((s) => lower.includes(s))) {
    return {
      kind: 'network',
      title: 'Network error',
      raw,
      retriable: true,
    };
  }

  if (lower.includes('response corrupted')) {
    return {
      kind: 'corrupted',
      title: 'Response corrupted',
      raw,
      retriable: true,
    };
  }

  return {
    kind: 'unknown',
    title: 'Something went wrong',
    raw,
    retriable: true,
  };
}

/**
 * Maps the Arcane server's SSE `{type:'error', code?, message}` event code
 * to a `TurnErrorKind`, for the stream layer (T4) to use when a structured
 * code is available (rather than substring-matching `message`). Returns
 * `null` for an absent/unrecognized code, so the caller falls back to
 * `classifyTurnError(message)`.
 */
export function classifyServerCode(code: string | undefined): TurnErrorKind | null {
  switch (code) {
    case 'rate_limit':
      return 'rate_limit';
    case 'model_error':
      return 'server';
    case 'server_error':
      return 'server';
    default:
      return null;
  }
}

/** Fixed `TurnError` for a `detectTurnOutcome` `{ type: 'crash' }` result — the loop died with no error/aborted/end-turn exit. */
export function loopCrashError(): TurnError {
  return {
    kind: 'crash',
    title: 'Agent stopped unexpectedly',
    detail: 'Check the devtools console for the stack trace.',
    raw: 'The agent loop ended without a final response, error, or abort.',
    retriable: true,
  };
}

export type TurnOutcome =
  | { type: 'clean' }
  | { type: 'aborted' }
  | { type: 'error'; raw: string }
  | { type: 'crash' };

/**
 * Determines how a send ended, given ONLY the messages appended during this
 * send (not the full conversation history). Rules (exact, in order):
 *  1. No assistant message at all -> crash.
 *  2. Last assistant message has `stopReason === 'error'` -> error, with its
 *     `errorMessage` (or a fallback) as `raw`.
 *  3. `stopReason === 'aborted'` OR `abortRequested` -> aborted (abortRequested
 *     wins over a toolUse tail: an abort mid-tool-execution still leaves
 *     `stopReason: 'toolUse'`).
 *  4. `stopReason === 'toolUse'` (and not aborted) -> crash (the loop's only
 *     legal exits are error/aborted/end-turn; a toolUse tail means it died
 *     mid-turn).
 *  5. Otherwise -> clean.
 */
export function detectTurnOutcome(newMessages: AgentMessage[], abortRequested: boolean): TurnOutcome {
  let lastAssistant: AssistantMessage | undefined;
  for (let i = newMessages.length - 1; i >= 0; i--) {
    const m = newMessages[i];
    if (m.role === 'assistant') {
      lastAssistant = m;
      break;
    }
  }

  if (!lastAssistant) return { type: 'crash' };

  if (lastAssistant.stopReason === 'error') {
    return { type: 'error', raw: lastAssistant.errorMessage ?? 'Unknown error' };
  }

  if (lastAssistant.stopReason === 'aborted' || abortRequested) {
    return { type: 'aborted' };
  }

  if (lastAssistant.stopReason === 'toolUse') {
    return { type: 'crash' };
  }

  return { type: 'clean' };
}

/**
 * Walks backward from the message with id `errorMessageId` in the STORE
 * message list, skipping non-user messages (toolResult/assistant/system/
 * error kinds), and returns the nearest preceding `role === 'user'` message
 * plus `truncateAfterId` (that user message's id — the point a Retry should
 * truncate history back to before re-sending). Returns `null` if no such
 * user message exists, or if `errorMessageId` isn't found at all.
 */
export function findRetryTarget(
  messages: AiMessage[],
  errorMessageId: string,
): { userMessage: AiMessage; truncateAfterId: string } | null {
  const errorIndex = messages.findIndex((m) => m.id === errorMessageId);
  if (errorIndex === -1) return null;

  for (let i = errorIndex - 1; i >= 0; i--) {
    const candidate = messages[i];
    if (candidate.role === 'user') {
      return { userMessage: candidate, truncateAfterId: candidate.id };
    }
  }

  return null;
}

/**
 * True iff any block in `blocks` is a text block with non-whitespace text, a
 * thinking block with non-whitespace text, or a toolCall block. Used to
 * decide whether an assistant message is worth rendering (vs. e.g. a
 * tool-free empty-content tail).
 */
export function hasRenderableContent(blocks: AiMessage['content']): boolean {
  if (!blocks) return false;
  return blocks.some((block) => {
    if (block.type === 'text') return block.text.trim().length > 0;
    if (block.type === 'thinking') return block.thinking.trim().length > 0;
    if (block.type === 'toolCall') return true;
    return false;
  });
}
