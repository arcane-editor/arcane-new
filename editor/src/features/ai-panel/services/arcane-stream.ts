/**
 * Arcane server streaming integration.
 * Implements the StreamFn that replaces PI's direct provider calls
 * with calls to the Arcane Cloudflare Workers server.
 *
 * Hardening (P3.1): the initial connect (fetch + non-OK response) is
 * retried with linear backoff on network errors / 429 / 5xx, bounded by a
 * per-attempt connect timeout; once SSE bytes start arriving, an idle-gap
 * watchdog aborts the read if no chunk arrives for too long. Both timeouts
 * exist because Cloudflare Workers AI has, in practice, hung for as long as
 * ~53 minutes with no response — see `stream-retry.ts` and the eval
 * harness's `eval-stream.ts`, which share the same primitives. The connect
 * timeout is a plain, cancellable `AbortController` (not `AbortSignal.
 * timeout()`, which can't be disarmed) — it's cleared the moment the
 * connect phase succeeds, so it never governs the SSE read loop; only the
 * idle-gap watchdog does once streaming has started.
 */

import { useAuthStore } from '../../../stores/auth';
import { useAiStore } from '../../../stores/ai';
import { useConnectivityStore } from '../../../stores/connectivity';
import type {
  Context,
  StreamOptions,
  StreamFn,
  AssistantMessage,
} from './vendor/types';
import { AssistantMessageEventStream } from './vendor/event-stream';
import { nextTurnTelemetry, recordTurnLatency } from './turn-telemetry';
import { convertToOpenAI } from './openai-format';
import { getStreamExtras } from './stream-extras';
import { combineSignals, computeBackoffMs, isTransient, raceWithTimeout, sleep, TimeoutRaceError } from './stream-retry';
import { ARCANE_API_URL } from '../../../config/api';

const ARCANE_SERVER_URL = ARCANE_API_URL;

/**
 * First-token watchdog default: abort if no SSE chunk arrives at all within
 * this window of the very first `reader.read()` call (before any content has
 * streamed). A hung-but-open connect otherwise looks identical to "nothing
 * happening" for the full 90s idle-gap window below — this bounds it much
 * tighter since a healthy stream should produce SOMETHING quickly. Every
 * read after the first keeps falling under the (longer) idle-gap watchdog.
 */
const FIRST_TOKEN_TIMEOUT_MS = 25_000;

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
  /**
   * Provider-reported cached-prefix input tokens, when available. 0/undefined
   * today — CF Workers AI exposes no prefix-caching API (see AI-SPEC.md
   * "Prompt caching status") — parsed here for forward-compatibility only.
   */
  cached_input_tokens?: number;
  message?: string;
  /**
   * Structured error classification from the Arcane server (T1's gateway
   * work), present alongside `message` on `type: 'error'` events. When set,
   * folded into the error message as a leading `[code:<x>]` marker that
   * `turn-errors.ts`'s `classifyTurnError` strips and maps precisely (rather
   * than substring-matching `message`).
   */
  code?: 'model_error' | 'rate_limit' | 'server_error';
}

export interface ArcaneStreamHardeningConfig {
  /** Injectable for tests; defaults to global `fetch`. Production call sites never pass this. */
  fetchImpl?: typeof fetch;
  /** Total attempts (including the first) for the initial connect phase, before any SSE byte is read. Default 3. */
  maxAttempts?: number;
  /** Linear backoff base: delay before retry N is `retryBaseDelayMs * N` (default 5000 -> 5s, 10s). */
  retryBaseDelayMs?: number;
  /** Per-attempt connect timeout, matching the eval harness's hardening. Default 180_000ms. */
  connectTimeoutMs?: number;
  /** Idle-gap watchdog once streaming: abort if no SSE chunk arrives within this window. Default 90_000ms. */
  idleTimeoutMs?: number;
  /**
   * First-token watchdog: governs ONLY the very first `reader.read()` call
   * (before any chunk has arrived at all). Injectable/overridable the same
   * way `idleTimeoutMs` is, for tests. Default `FIRST_TOKEN_TIMEOUT_MS`
   * (25s) — much tighter than the 90s idle-gap window, since a hung connect
   * with zero bytes ever sent should be surfaced far sooner than a stall
   * mid-stream.
   */
  firstTokenTimeoutMs?: number;
}

interface ResolvedArcaneStreamConfig {
  fetchImpl: typeof fetch;
  maxAttempts: number;
  retryBaseDelayMs: number;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  firstTokenTimeoutMs: number;
}

function abortedMessage(): AssistantMessage {
  return { role: 'assistant', content: [], stopReason: 'aborted', timestamp: Date.now() };
}

/**
 * Builds the `error` event pushed when a stream produced no content blocks
 * but did see `malformedLines` unparseable `data:` lines — a corrupted
 * response, distinct from a clean empty turn. Called from both stream-
 * finalize points (the `[DONE]` branch and the reader-end fallthrough); by
 * construction `contentBlocks` is empty at both call sites, matching the
 * other error pushes in this file (`partial` with `stopReason: 'error'` and
 * `errorMessage` mirroring the thrown error's message).
 */
function corruptionErrorEvent(
  malformedLines: number,
  contentBlocks: AssistantMessage['content'],
): { type: 'error'; error: Error; partial: AssistantMessage } {
  const message = `Response corrupted — ${malformedLines} unreadable event(s) from the server`;
  return {
    type: 'error',
    error: new Error(message),
    partial: {
      role: 'assistant',
      content: contentBlocks,
      stopReason: 'error',
      errorMessage: message,
      timestamp: Date.now(),
    },
  };
}

/**
 * Builds a StreamFn against the Arcane server with the given hardening
 * config. Exists mainly so tests can inject a fake `fetch` and tiny
 * timeouts/attempt counts; production uses the pre-built `arcaneStream`
 * below (defaults only, real `fetch`) so the `agent-service.ts` call site
 * (`streamFn: arcaneStream`) never changes.
 */
export function createArcaneStreamFn(config: ArcaneStreamHardeningConfig = {}): StreamFn {
  const resolved: ResolvedArcaneStreamConfig = {
    // Bound to the global on the way in. This lands on a config object and is
    // then invoked as `cfg.fetchImpl(...)` below — a method call, so an unbound
    // `fetch` would receive `cfg` as its `this`. WKWebView (Tauri's macOS
    // webview) enforces the WebIDL brand check and throws "Can only call
    // Window.fetch on instances of Window", killing every send before it
    // reaches the network.
    fetchImpl: (config.fetchImpl ?? fetch).bind(globalThis),
    maxAttempts: config.maxAttempts ?? 3,
    retryBaseDelayMs: config.retryBaseDelayMs ?? 5_000,
    connectTimeoutMs: config.connectTimeoutMs ?? 180_000,
    idleTimeoutMs: config.idleTimeoutMs ?? 90_000,
    firstTokenTimeoutMs: config.firstTokenTimeoutMs ?? FIRST_TOKEN_TIMEOUT_MS,
  };

  return (context: Context, options: StreamOptions): AssistantMessageEventStream => {
    const stream = new AssistantMessageEventStream();

    doStream(context, options, stream, resolved).catch((error) => {
      stream.push({
        type: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
      });
    });

    return stream;
  };
}

/** Production StreamFn — default hardening config, real `fetch`. */
export const arcaneStream: StreamFn = createArcaneStreamFn();

async function doStream(
  context: Context,
  options: StreamOptions,
  stream: AssistantMessageEventStream,
  cfg: ResolvedArcaneStreamConfig,
): Promise<void> {
  // Wall-clock start for this request's `lastTurnLatencyMs` telemetry (P4) —
  // covers the full request including any connect retries, since a retried
  // attempt is still logically the same outgoing turn.
  const requestStartTime = Date.now();

  const token = useAuthStore.getState().token;
  if (!token) {
    stream.push({
      type: 'error',
      error: new Error('Not logged in. Please sign in to use the AI assistant.'),
    });
    return;
  }

  // Offline fast-fail: no point burning 3 retries × long timeouts when the
  // OS says there's no network. The connectivity store heals via window
  // events + periodic re-sync, and the error block's Retry covers resume.
  if (!useConnectivityStore.getState().online) {
    stream.push({
      type: 'error',
      error: new Error("You're offline — check your internet connection, then retry."),
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
  // Task-aware routing signals (server config/routing.ts), derived from the
  // conversation's FIRST user message so every send of a conversation routes
  // identically — provider prompt caches are per-model, so the routed model
  // must be sticky per conversation. Conservative by construction: a false
  // codeIntent positive merely skips a cost downgrade.
  const firstUser = context.messages.find((m) => m.role === 'user');
  const firstUserText = !firstUser
    ? ''
    : typeof firstUser.content === 'string'
      ? firstUser.content
      : firstUser.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('\n');
  const routing = {
    promptChars: firstUserText.length,
    codeIntent: /```|\b(write|edit|refactor|implement|fix|create|add|build|rename|generate)\b/i.test(
      firstUserText,
    ),
    hasAttachments: firstUserText.includes('<attachments>'),
  };
  // Map the UI mode to the server's taskType enum ('chat' | 'edit' | 'plan' |
  // 'explain'). Model choice is fully backend-driven off `reasoningLevel`; this
  // is metadata for logging only.
  const taskType = currentMode === 'ask' ? 'chat' : currentMode === 'plan' ? 'plan' : 'edit';
  // Per-task output ceiling so the server clamp has a sane per-mode cap (the
  // server still clamps to the model's published max). Q&A rarely needs 8k;
  // agentic edits / plans can. Caps the output cost driver alongside compaction.
  const maxTokensByTask = { chat: 16384, plan: 24576, edit: 24576 } as const;
  // Built once and sent unchanged on every retry attempt below: telemetry's
  // `turnIndex` increments once per agent-loop turn, so a retried attempt
  // (still the same logical turn/request) must not inflate it by calling
  // `nextTurnTelemetry()` again per attempt.
  const extras = getStreamExtras(context);
  const requestBody = JSON.stringify({
    messages,
    tools: tools.length > 0 ? tools : undefined,
    // Turn-governor at cap: tools stay in the request (cached prefix) but the
    // model is told not to call them.
    ...(extras?.toolChoice ? { tool_choice: extras.toolChoice } : {}),
    stream: true,
    max_tokens: maxTokensByTask[taskType],
    metadata: {
      taskType,
      mode: currentMode,
      reasoningLevel: options.reasoning ?? 'low',
      // Conversation id — the server derives provider prompt-cache routing
      // hints from it (prompt_cache_key / x-session-affinity).
      sessionId: useAiStore.getState().sessionId ?? undefined,
      routing,
      telemetry: nextTurnTelemetry(),
    },
  });

  let response: Response | undefined;

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    // Dedicated connect-phase timeout: a plain `AbortController` we control
    // directly, NOT `AbortSignal.timeout()` — that timer can't be cancelled,
    // so it would keep running past a successful connect and abort the SSE
    // reader mid-stream once it fires (Finding 1). The `finally` below
    // clears it the instant this attempt's fetch settles — success or
    // failure — so it only ever bounds "time to first response," never the
    // read loop that follows a successful connect.
    const connectController = new AbortController();
    const connectTimer = setTimeout(() => connectController.abort(), cfg.connectTimeoutMs);
    const signal = combineSignals([options.signal, connectController.signal]);

    let attemptResponse: Response;
    try {
      try {
        attemptResponse = await cfg.fetchImpl(`${ARCANE_SERVER_URL}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: requestBody,
          signal,
        });
      } catch (error) {
        // Only flip the connectivity store offline for a GENUINE network
        // failure: a fetch throw that neither abort source on this attempt
        // caused. Two things can abort `signal` (the combined signal above)
        // without the network being at fault — our own per-attempt
        // connect-timeout controller (`connectController`) and the caller's
        // `options.signal` (user hit Stop / navigated away) — and both must
        // be excluded, or a Stop click or a plain connect-timeout falsely
        // flips the store offline, making the *next* send fast-fail with
        // "You're offline" for up to 30s while fully online. An un-aborted
        // throw is the real network signal.
        if (!connectController.signal.aborted && !options.signal?.aborted) {
          useConnectivityStore.getState().reportFetchFailure();
        }
        // A genuine caller cancellation (user hit stop / navigated away) is
        // not a transient failure worth retrying — surface the existing
        // clean "aborted" done event immediately, same as before hardening.
        // (Our own per-attempt connect timeout above also throws here, but
        // `options.signal` — the *caller's* signal — won't be aborted in
        // that case, so it falls through to the retry path below instead.)
        if (options.signal?.aborted) {
          stream.push({ type: 'done', message: abortedMessage() });
          return;
        }
        if (attempt >= cfg.maxAttempts) {
          throw error instanceof Error ? error : new Error(String(error));
        }
        const delay = computeBackoffMs(attempt, cfg.retryBaseDelayMs);
        try {
          await sleep(delay, options.signal);
        } catch {
          stream.push({ type: 'done', message: abortedMessage() });
          return;
        }
        continue;
      }
    } finally {
      // Disarm regardless of outcome: a successful connect must not carry
      // this timer into the read loop, and a failed/retried attempt must
      // not leak it into the next iteration's lifetime.
      clearTimeout(connectTimer);
    }

    if (!attemptResponse.ok) {
      // ONLY 401 ends a session. A 403 means the session is valid but the
      // action isn't allowed — most often `email_unverified`, which gates
      // every AI route. Signing the user out over that trapped every
      // email/password signup in a loop: sign in → first message → 403 →
      // "your session expired" → sign in → identical 403, forever. (Google
      // signups are auto-verified, which is why it looked intermittent.)
      if (attemptResponse.status === 403) {
        const body = (await attemptResponse.json().catch(() => ({}))) as { error?: string; code?: string };
        if (body.error === 'email_unverified') {
          useAiStore.getState().setVerificationRequired(true);
          throw new Error(
            'Verify your email address to use AI features. Check your inbox for the verification link.',
          );
        }
        if (body.code === 'tier_not_available') {
          // Deep Think / Max gated to paid plans — never retried (a retry
          // can't change the plan gate). Folded into the same leading
          // `[code:<x>]` marker the SSE error path uses, so
          // `classifyTurnError` (turn-errors.ts) routes it to the
          // 'tier_gated' kind and its upgrade CTA rather than the generic
          // 403 fallback below.
          throw new Error(
            `[code:tier_not_available] ${body.error ?? 'Deep Think and Max are available on paid plans.'}`,
          );
        }
        throw new Error(body.error ?? `Request forbidden (${attemptResponse.status})`);
      }

      if (attemptResponse.status === 401) {
        // Expired/revoked token: clear local auth state so the Arcane
        // sign-in gate appears and we avoid repeated unauthorized calls.
        // Never retried — a retry would just repeat the same 401.
        // Set BEFORE logout() so the notice is already in the store by the
        // time the sign-in gate replaces the timeline.
        useAiStore
          .getState()
          .setAuthNotice('Your session expired and you were signed out. Sign in again to continue.');
        await useAuthStore.getState().logout().catch(() => {});
        throw new Error('Authentication expired. Please log in again.');
      }

      if (attemptResponse.status === 402) {
        // Out of credits — never retried (a retry can't change the balance).
        // Refresh the store so the Account tab reflects the empty balance,
        // then surface the server's actionable message (upgrade / top up).
        void useAuthStore.getState().refreshUsage();
        const body = (await attemptResponse.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'You are out of AI credits. Open Account to upgrade or buy credits.');
      }

      if (isTransient(attemptResponse.status) && attempt < cfg.maxAttempts) {
        const delay = computeBackoffMs(attempt, cfg.retryBaseDelayMs);
        try {
          await sleep(delay, options.signal);
        } catch {
          stream.push({ type: 'done', message: abortedMessage() });
          return;
        }
        continue;
      }

      const errorText = await attemptResponse.text().catch(() => 'Unknown error');
      if (attemptResponse.status === 429) {
        throw new Error('Rate limit exceeded. Please wait a moment and try again.');
      }
      throw new Error(`Server error (${attemptResponse.status}): ${errorText}`);
    }

    response = attemptResponse;
    break;
  }

  // Unreachable in practice: the loop above always either returns, throws,
  // or sets `response` before falling out. Guards TypeScript's control-flow
  // analysis of `response`.
  if (!response) throw new Error('Arcane stream: exhausted retries with no response');

  if (!response.body) {
    throw new Error('No response body');
  }

  // Emit start event
  stream.push({ type: 'start' });

  // Parse SSE stream. From here on, failures are NOT retried — partial
  // content already delivered to the caller can't be replayed into a fresh
  // request.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let contentIndex = 0;
  let thinkingIndex = -1;
  let toolCallIndices: Map<string, number> = new Map();
  const contentBlocks: AssistantMessage['content'] = [];
  // Count of `data:` lines that failed JSON.parse. If the whole stream turns
  // out to be nothing but noise (no content blocks produced), that's a
  // corrupted response worth surfacing distinctly rather than silently
  // finalizing as an empty "done" (which today renders as an empty bubble).
  let malformedLines = 0;
  // Tracks whether the NEXT `reader.read()` is the very first one this
  // stream makes — governed by the tighter first-token watchdog below rather
  // than the 90s idle-gap window, since a hung connect that never sends a
  // single byte should be surfaced much sooner than a mid-stream stall.
  // Flipped false right after that first read, regardless of outcome, so
  // every subsequent read falls back to the idle-gap timeout as before.
  let firstRead = true;

  try {
    while (true) {
      // Idle-gap watchdog: race each read individually rather than keeping a
      // persistent resettable timer, so the guarded gap is naturally "time
      // since the last chunk" (or since the stream started, for the first
      // chunk) with no separate reset bookkeeping. The very first read gets
      // the tighter first-token timeout instead of the idle one.
      const { done, value } = await raceWithTimeout(
        reader.read(),
        firstRead ? cfg.firstTokenTimeoutMs : cfg.idleTimeoutMs,
        firstRead
          ? 'Stream stalled before the first token'
          : `Stream stalled — no data for ${cfg.idleTimeoutMs}ms`,
        () => {
          reader.cancel().catch(() => {});
        },
      );
      firstRead = false;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          if (contentBlocks.length === 0 && malformedLines > 0) {
            stream.push(corruptionErrorEvent(malformedLines, contentBlocks));
            return;
          }
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
          malformedLines++;
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
            // A structured `code` (T1's gateway work) takes precedence: fold
            // it into a leading `[code:<x>]` marker that `classifyTurnError`
            // strips and maps precisely, instead of substring-matching
            // `message` alone.
            const message = event.code
              ? `[code:${event.code}] ${event.message ?? 'Unknown server error'}`
              : (event.message ?? 'Unknown server error');
            stream.push({
              type: 'error',
              error: new Error(message),
              partial: {
                role: 'assistant',
                content: contentBlocks,
                stopReason: 'error',
                errorMessage: message,
                timestamp: Date.now(),
              },
            });
            return;
          }
          case 'usage': {
            // Not pushed through the AssistantMessageEventStream (its event
            // type is vendor code we don't touch) — recorded directly here
            // instead: the last-completed-request latency into turn-telemetry
            // (surfaced to the server on the NEXT request, P4) and a session-
            // cumulative counter into the ai store (for later UI surfacing;
            // nothing renders it yet).
            recordTurnLatency(Date.now() - requestStartTime);
            useAiStore.getState().recordSessionUsage(event.input_tokens ?? 0, event.output_tokens ?? 0);
            break;
          }
        }
      }
    }
  } catch (err) {
    if (err instanceof TimeoutRaceError) {
      stream.push({
        type: 'error',
        error: err,
        partial: {
          role: 'assistant',
          content: contentBlocks,
          stopReason: 'error',
          errorMessage: err.message,
          timestamp: Date.now(),
        },
      });
      return;
    }
    throw err;
  } finally {
    reader.releaseLock();
  }

  // If we reach here without [DONE], finalize
  if (contentBlocks.length === 0 && malformedLines > 0) {
    stream.push(corruptionErrorEvent(malformedLines, contentBlocks));
    return;
  }
  const finalMessage: AssistantMessage = {
    role: 'assistant',
    content: contentBlocks,
    stopReason: 'stop',
    timestamp: Date.now(),
  };
  stream.push({ type: 'done', message: finalMessage });
}
