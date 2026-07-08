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
 * harness's `eval-stream.ts`, which share the same primitives.
 */

import { useAuthStore } from '../../../stores/auth';
import { useAiStore } from '../../../stores/ai';
import type {
  Context,
  StreamOptions,
  StreamFn,
  AssistantMessage,
} from './vendor/types';
import { AssistantMessageEventStream } from './vendor/event-stream';
import { nextTurnTelemetry } from './turn-telemetry';
import { convertToOpenAI } from './openai-format';
import { combineSignals, computeBackoffMs, isTransient, raceWithTimeout, sleep, TimeoutRaceError } from './stream-retry';

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
}

interface ResolvedArcaneStreamConfig {
  fetchImpl: typeof fetch;
  maxAttempts: number;
  retryBaseDelayMs: number;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
}

function abortedMessage(): AssistantMessage {
  return { role: 'assistant', content: [], stopReason: 'aborted', timestamp: Date.now() };
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
    fetchImpl: config.fetchImpl ?? fetch,
    maxAttempts: config.maxAttempts ?? 3,
    retryBaseDelayMs: config.retryBaseDelayMs ?? 5_000,
    connectTimeoutMs: config.connectTimeoutMs ?? 180_000,
    idleTimeoutMs: config.idleTimeoutMs ?? 90_000,
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
  // Built once and sent unchanged on every retry attempt below: telemetry's
  // `turnIndex` increments once per agent-loop turn, so a retried attempt
  // (still the same logical turn/request) must not inflate it by calling
  // `nextTurnTelemetry()` again per attempt.
  const requestBody = JSON.stringify({
    messages,
    tools: tools.length > 0 ? tools : undefined,
    stream: true,
    max_tokens: maxTokensByTask[taskType],
    metadata: {
      taskType,
      mode: currentMode,
      reasoningLevel: options.reasoning ?? 'mid',
      telemetry: nextTurnTelemetry(),
    },
  });

  let response: Response | undefined;

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    const signal = combineSignals([options.signal, AbortSignal.timeout(cfg.connectTimeoutMs)]);

    let attemptResponse: Response;
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

    if (!attemptResponse.ok) {
      if (attemptResponse.status === 401 || attemptResponse.status === 403) {
        // Expired/revoked token: clear local auth state so the Arcane
        // sign-in gate appears and we avoid repeated unauthorized calls.
        // Never retried — a retry would just repeat the same 401/403.
        await useAuthStore.getState().logout().catch(() => {});
        throw new Error('Authentication expired. Please log in again.');
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

  try {
    while (true) {
      // Idle-gap watchdog: race each read individually rather than keeping a
      // persistent resettable timer, so the guarded gap is naturally "time
      // since the last chunk" (or since the stream started, for the first
      // chunk) with no separate reset bookkeeping.
      const { done, value } = await raceWithTimeout(
        reader.read(),
        cfg.idleTimeoutMs,
        `Stream stalled — no data for ${cfg.idleTimeoutMs}ms`,
        () => {
          reader.cancel().catch(() => {});
        },
      );
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
  const finalMessage: AssistantMessage = {
    role: 'assistant',
    content: contentBlocks,
    stopReason: 'stop',
    timestamp: Date.now(),
  };
  stream.push({ type: 'done', message: finalMessage });
}
