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
  | 'credits'
  | 'tier_gated'
  | 'rate_limit'
  | 'hourly_cap'
  | 'server'
  | 'network'
  | 'timeout'
  | 'corrupted'
  | 'context_overflow'
  | 'crash'
  | 'empty'
  | 'unknown';

export interface TurnError {
  kind: TurnErrorKind;
  title: string; // human headline, e.g. "Server error (502)"
  detail?: string; // one-line guidance, e.g. "This is usually temporary — try again in a moment."
  raw: string; // full original message (expandable section in the UI)
  retriable: boolean;
  /**
   * Epoch ms at which a retry is expected to succeed — set only when the
   * server sent a `retryAfter:<seconds>` marker (the account hourly cap, or a
   * mid-stream provider 429 that carried a `Retry-After`), computed once at
   * classification time (`Date.now() + seconds * 1000`). Persisted with the
   * rest of the error (session files serialize the whole message, `turnError`
   * included), so a restored session still shows a correct countdown.
   * `ErrorBlock` gates its Retry button on this and ticks a live countdown;
   * `detail` may carry a literal `{countdown}` placeholder for it to fill in.
   */
  retryAt?: number;
}

const NETWORK_SUBSTRINGS = [
  'failed to fetch',
  'load failed', // WKWebView on macOS produces "Load failed" for network errors
  'error sending request',
  'fetch failed',
  'network',
  'no response body',
];

/** Matches a leading `[code:<x>]` marker (server-side SSE error code /
 * hourly-cap 429, `hosted-stream.ts`), optionally carrying a `retryAfter:<seconds>`
 * hint, e.g. `[code:rate_limit] slow down` or
 * `[code:hourly_cap retryAfter:2820] Too many AI requests...`. */
const CODE_MARKER = /^\[code:([a-z_]+)(?:\s+retryAfter:(\d+))?\]\s*/;

/**
 * Classifies a raw error message (from `AssistantMessage.errorMessage` or a
 * caught exception's `.message`) into a `TurnError`. A leading `[code:<x>]`
 * marker takes precedence over the substring table below: it's stripped from
 * `raw` first (whether or not the code is recognized), then a recognized
 * code maps directly to a kind/title; an unrecognized code falls through to
 * the table on the stripped remainder.
 */
/**
 * A context-length rejection is DETERMINISTIC — the same history overflows the
 * same window every time — but it reaches us as the server's generic
 * `model_error`, which maps to kind 'server' and tells the user "this is
 * usually temporary — try again in a moment". The one error where retrying is
 * guaranteed to fail was the one the UI pushed hardest to retry.
 *
 * Matched on the provider's own wording because there is no structured code for
 * it: the server's `classifyStreamError` only ever emits `rate_limit` or
 * `model_error`. Patterns are deliberately specific — "token" alone appears in
 * plenty of unrelated failures.
 */
const CONTEXT_OVERFLOW_PATTERNS = [
  /context[_ ]length/i,
  /maximum context/i,
  /context window/i,
  /prompt is too long/i,
  /too many tokens/i,
  /reduce the length of the messages/i,
  /input validation error[\s\S]*tokens/i,
];

function contextOverflowError(raw: string): TurnError | null {
  if (!CONTEXT_OVERFLOW_PATTERNS.some((re) => re.test(raw))) return null;
  return {
    kind: 'context_overflow',
    title: 'Conversation too long',
    detail:
      'This conversation no longer fits the model\'s context window. Start a new chat, ' +
      'or remove large attachments, and send a shorter message.',
    raw,
    retriable: false,
  };
}

export function classifyTurnError(raw: string): TurnError {
  const codeMatch = CODE_MARKER.exec(raw);
  if (codeMatch) {
    const stripped = raw.slice(codeMatch[0].length);
    // Present only when the server sent a `retryAfter:<seconds>` hint
    // (the hourly cap always does; a mid-stream provider rate_limit only
    // when the provider itself sent a `Retry-After`). Computed once, here,
    // at classification time — NOT re-derived on every render — so a
    // restored session's countdown is anchored to when the error actually
    // happened, not when the transcript was reopened.
    const retryAfterSeconds = codeMatch[2] !== undefined ? parseInt(codeMatch[2], 10) : undefined;
    const retryAt = retryAfterSeconds !== undefined ? Date.now() + retryAfterSeconds * 1000 : undefined;
    // Before the code mapping: a context overflow arrives tagged `model_error`,
    // which would otherwise return the retriable 'server' branch below.
    const overflow = contextOverflowError(stripped);
    if (overflow) return overflow;
    const kind = classifyServerCode(codeMatch[1]);
    if (kind === 'hourly_cap') {
      return {
        kind: 'hourly_cap',
        title: 'Hourly usage limit reached',
        detail:
          retryAt !== undefined
            ? "You have used this hour's AI spend allowance. Retry unlocks in {countdown}."
            : 'Try again in about an hour.',
        raw: stripped,
        retriable: true,
        ...(retryAt !== undefined ? { retryAt } : {}),
      };
    }
    if (kind === 'rate_limit') {
      return {
        kind: 'rate_limit',
        title: 'Rate limited',
        detail:
          retryAt !== undefined
            ? 'The model provider is busy. Retry unlocks in {countdown}.'
            : 'Too many requests — wait a moment and try again.',
        raw: stripped,
        retriable: true,
        ...(retryAt !== undefined ? { retryAt } : {}),
      };
    }
    if (kind === 'server') {
      return {
        kind: 'server',
        title: 'Server error',
        detail: 'This is usually temporary — try again in a moment.',
        raw: stripped,
        retriable: true,
      };
    }
    if (kind === 'timeout') {
      return {
        kind: 'timeout',
        title: 'Connection timed out',
        detail: 'This is usually temporary — try again in a moment.',
        raw: stripped,
        retriable: true,
      };
    }
    if (kind === 'tier_gated') {
      // Never retried — a retry can't change the plan gate, only an
      // upgrade can. Routed to a distinct kind from 'credits' so ErrorBlock
      // shows an upgrade CTA rather than the out-of-credits one.
      return {
        kind: 'tier_gated',
        title: 'Upgrade required',
        detail: 'Deep Think and Max are available on paid plans.',
        raw: stripped,
        retriable: false,
      };
    }
    return classifyTurnErrorTable(stripped);
  }
  return contextOverflowError(raw) ?? classifyTurnErrorTable(raw);
}

/** Substring-based classification table — first match wins (T3 brief). */
function classifyTurnErrorTable(raw: string): TurnError {
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

  if (lower.includes('out of credits') || lower.includes('out of ai credits')) {
    return {
      kind: 'credits',
      // Owner directive: never a raw credit number user-facing — this 402
      // means the account's balance is at/below zero, i.e. 100% of the
      // monthly grant is spent, so that's the figure shown here rather than
      // "Out of credits". ErrorBlock's existing "Manage plan & credits" CTA
      // (kind === 'credits') is unaffected.
      title: 'Out of AI usage',
      detail: "You've used 100% of your monthly AI usage. Upgrade your plan or add a top-up to continue.",
      raw,
      retriable: false,
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

  // Distinct from 'stream stalled' above: this fires when the connection
  // dropped mid-response AFTER content had already started (hosted-stream.ts's
  // reader-end-without-[DONE] fallthrough), not before any byte arrived. The
  // partial reply is still on screen, so the copy calls that out explicitly
  // rather than reusing the generic network wording below.
  if (lower.includes('stream ended unexpectedly')) {
    return {
      kind: 'network',
      title: 'Response cut off',
      detail:
        'The connection dropped before the reply finished. Retry sends this message again and replaces the partial reply above.',
      raw,
      retriable: true,
    };
  }

  if (lower.includes("you're offline") || lower.includes('you are offline')) {
    return {
      kind: 'network',
      title: "You're offline",
      detail: 'Check your internet connection, then press Retry.',
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

  if (/^empty response/i.test(raw)) {
    return {
      kind: 'empty',
      title: 'Empty response',
      detail: 'The model returned no output. This is usually transient — try again.',
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
 * Maps a structured error code to a `TurnErrorKind`, for callers that have a
 * code available (rather than substring-matching a message) — the SSE
 * `{type:'error', code?, message, retryAfterSeconds?}` event (`hosted-stream.ts`)
 * for `rate_limit`/`model_error`/`server_error`, the pre-flight 403
 * `tier_not_available` gate, and the pre-flight 429 `hourly_cap` (account
 * spend cap, free plan only) — all folded into a `[code:<x>]` marker (with an
 * optional `retryAfter:<seconds>` for the last two) by `hosted-stream.ts`
 * before reaching here. Returns `null` for an
 * absent/unrecognized code, so the caller falls back to
 * `classifyTurnError(message)`.
 *
 * All routing through a provider fallback is gone — one provider, no
 * fallback model, so `provider_rate_limit` / `provider_auth_failure` /
 * `provider_unavailable` / `gateway_timeout` no longer exist server-side and
 * are deliberately NOT handled here; an unrecognized code (including these)
 * falls through to the substring table like any other.
 */
export function classifyServerCode(code: string | undefined): TurnErrorKind | null {
  switch (code) {
    case 'rate_limit':
      return 'rate_limit';
    case 'model_error':
      return 'server';
    case 'server_error':
      return 'server';
    case 'tier_not_available':
      return 'tier_gated';
    case 'hourly_cap':
      return 'hourly_cap';
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
 * True iff any assistant message in `newMessages` contains a `toolCall`
 * content block — i.e. the loop actually invoked a tool at some point this
 * turn, even if that message isn't the last one. Used by `detectTurnOutcome`
 * rule 5 to distinguish a genuinely empty turn (nothing happened at all —
 * worth surfacing as an error) from a turn that did real work via tools and
 * simply ended with no closing text (the model "went silent after acting" —
 * legitimate, not an error).
 */
function turnHasToolCall(newMessages: AgentMessage[]): boolean {
  return newMessages.some(
    (m) => m.role === 'assistant' && m.content.some((block) => block.type === 'toolCall'),
  );
}

/**
 * Determines how a send ended, given ONLY the messages appended during this
 * send (not the full conversation history). Rules (exact, in order):
 *  0. `abortRequested` -> aborted, unconditionally, before anything else
 *     inspects the tail. A user Stop can leave the vendor loop's tail in
 *     almost any shape — an aborted `fetch` rejects `reader.read()`, so
 *     `hosted-stream.ts` pushes an `'error'` event rather than a clean
 *     `'aborted'` done, and an abort mid-tool-execution never gets a chance
 *     to reach `'aborted'` at all (the tail stays `stopReason: 'toolUse'`,
 *     or there's no assistant message yet). Rather than caller-side
 *     suppression (T5's original approach — `agent-service.ts` skipped this
 *     whole function when `abortRequested`), abort wins as the very first
 *     check: a user-initiated Stop is authoritative over whatever the tail
 *     happens to look like, no matter which rule below would otherwise fire.
 *  1. No assistant message at all -> crash.
 *  2. Last assistant message has `stopReason === 'error'` -> error, with its
 *     `errorMessage` (or a fallback) as `raw`.
 *  3. `stopReason === 'aborted'` -> aborted (kept for the vendor loop's own
 *     clean-abort tail; rule 0 above already covers the caller-reported case,
 *     including when it wins over a toolUse tail).
 *  4. `stopReason === 'toolUse'` (and not aborted) -> crash (the loop's only
 *     legal exits are error/aborted/end-turn; a toolUse tail means it died
 *     mid-turn).
 *  5. The tail stopReason is otherwise a normal end ('stop'/'length'/
 *     undefined — anything not caught by rules 2-4) but the message has no
 *     renderable content (`hasRenderableContent` false) AND no assistant
 *     message this turn ever produced a `toolCall` block -> error, with a
 *     fixed `'Empty response from the model'` `raw` (classified by
 *     `classifyTurnError` into the `empty` kind below). VERIFIED against
 *     `agent-loop.ts`/`hosted-stream.ts`: the loop only re-enters (appending
 *     another assistant message) when the PREVIOUS assistant message carried
 *     a toolCall — and `hosted-stream.ts` only ever sets `stopReason:
 *     'toolUse'` on a message whose OWN content has a toolCall block. So a
 *     tail message with `stopReason` other than `'toolUse'` provably has no
 *     toolCall in its own content, but an EARLIER message in the same turn
 *     can (tool call -> toolResult -> final empty-text assistant message,
 *     "silence after acting") — hence checking the whole turn, not just the
 *     tail, before calling this an error.
 *  6. Otherwise -> clean.
 */
export function detectTurnOutcome(newMessages: AgentMessage[], abortRequested: boolean): TurnOutcome {
  if (abortRequested) return { type: 'aborted' };

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

  if (lastAssistant.stopReason === 'aborted') {
    return { type: 'aborted' };
  }

  if (lastAssistant.stopReason === 'toolUse') {
    return { type: 'crash' };
  }

  if (!hasRenderableContent(lastAssistant.content) && !turnHasToolCall(newMessages)) {
    return { type: 'error', raw: 'Empty response from the model' };
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
