import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { AssistantMessageEvent, Context, StreamOptions } from './vendor/types';
import { sleep } from './stream-retry';
import { resetTurnTelemetry, nextTurnTelemetry } from './turn-telemetry';
import { useConnectivityStore } from '../../../stores/connectivity';

// hosted-stream.ts pulls in `useAuthStore` / `useAiStore`, which (via the
// ai-panel barrel / theme store) transitively touch `document` — fine in the
// real Tauri webview, fatal under plain `bun test` (no DOM). Mock both
// stores at the module level *before* dynamically importing hosted-stream,
// so its real import graph (and any DOM-touching side effects in it) is
// never loaded. Static imports are hoisted above these statements, so the
// mocks must be registered first and the module under test imported via a
// dynamic `import()` afterwards.
let authState = { token: 'test-token' as string | null };
let logoutCalls = 0;
mock.module('../../../stores/auth', () => ({
  useAuthStore: {
    getState: () => ({
      token: authState.token,
      logout: async () => {
        logoutCalls++;
      },
    }),
  },
}));

let aiState: {
  mode: 'ask' | 'agent' | 'plan';
  hostedPlan: Array<{ status: string; difficulty?: 'easy' | 'hard' }> | null;
} = { mode: 'ask', hostedPlan: null };
let sessionUsageCalls: Array<{ inputTokens: number; outputTokens: number }> = [];
let authNoticeCalls: Array<string | null> = [];
let verificationRequiredCalls: boolean[] = [];
let servedModelCalls: string[] = [];
mock.module('../../../stores/ai', () => ({
  useAiStore: {
    getState: () => ({
      ...aiState,
      recordSessionUsage: (inputTokens: number, outputTokens: number) => {
        sessionUsageCalls.push({ inputTokens, outputTokens });
      },
      setAuthNotice: (notice: string | null) => {
        authNoticeCalls.push(notice);
      },
      setVerificationRequired: (required: boolean) => {
        verificationRequiredCalls.push(required);
      },
      recordServedModel: (model: string) => {
        servedModelCalls.push(model);
      },
    }),
  },
}));

const { createHostedStreamFn } = await import('./hosted-stream');
const { resetSendContext, setSendPromptMode } = await import('./send-context');

const ctx: Context = { systemPrompt: 'SYS', messages: [], tools: [] };
function opts(signal?: AbortSignal, reasoning?: string): StreamOptions {
  return { model: { id: 'm', name: 'm', provider: 'hosted' }, signal, reasoning };
}

function sseResponse(lines: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(new TextEncoder().encode(line));
      controller.close();
    },
  });
  return new Response(body, { status });
}

interface CapturedRequestBody {
  metadata: Record<string, unknown>;
}

/** Captures the JSON body of the (single, non-retried) fetch call for metadata assertions. */
function capturingFetchImpl(response: Response): { fetchImpl: typeof fetch; bodies: CapturedRequestBody[] } {
  const bodies: CapturedRequestBody[] = [];
  const fetchImpl = (async (_url: string, init?: { body?: string }) => {
    if (init?.body) bodies.push(JSON.parse(init.body));
    return response;
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

async function drain(events: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const collected: AssistantMessageEvent[] = [];
  for await (const ev of events) collected.push(ev);
  return collected;
}

/** Like `sseResponse`, but drips one chunk every `chunkDelayMs` instead of
 * enqueueing everything synchronously — used to simulate a stream whose
 * total lifetime exceeds the connect timeout while each individual gap
 * stays well under the idle-timeout threshold.
 *
 * Critically, this wires `signal` into the stream the same way a real
 * `fetch()` response body does: if the signal the request was made with
 * later aborts *while the body is still being read*, the read errors out.
 * That's the actual mechanism behind Finding 1 — passing a signal into
 * `fetch` doesn't just gate the connect phase, it keeps observing that
 * signal for the lifetime of the body read, so a fake that ignores `signal`
 * entirely can't reproduce the bug it's meant to guard against. */
function delayedSseResponse(chunks: string[], chunkDelayMs: number, signal?: AbortSignal, status = 200): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal?.aborted) {
        controller.error(new DOMException('The operation was aborted.', 'TimeoutError'));
        return;
      }
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, chunkDelayMs));
      if (signal?.aborted) {
        controller.error(new DOMException('The operation was aborted.', 'TimeoutError'));
        return;
      }
      controller.enqueue(new TextEncoder().encode(chunks[index]));
      index++;
    },
    cancel() {
      // no-op: mirrors a real stream's cancel() being a no-op once the
      // reader has already errored/closed.
    },
  });
  return new Response(body, { status });
}

beforeEach(() => {
  authState = { token: 'test-token' };
  logoutCalls = 0;
  aiState = { mode: 'ask', hostedPlan: null };
  sessionUsageCalls = [];
  authNoticeCalls = [];
  verificationRequiredCalls = [];
  servedModelCalls = [];
  resetSendContext();
  resetTurnTelemetry();
  // Several existing tests deliberately throw a genuine (un-aborted) error
  // from fetchImpl to exercise the retry path — the connect-phase catch
  // calls `reportFetchFailure()` for those, which flips this global zustand
  // store offline as a side effect and would otherwise leak into later tests
  // (whose own fetchImpl would then never even be called, per the offline
  // fast-fail check). Reset it clean before every test.
  useConnectivityStore.getState().setOnline(true);
});

describe('createHostedStreamFn', () => {
  it('retries once after a transient 500 and succeeds on the second attempt', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return new Response('3021: rate limiting', { status: 500 });
      return sseResponse(['data: {"type":"text","content":"hello"}\n\n', 'data: [DONE]\n\n']);
    }) as unknown as typeof fetch;

    const streamFn = createHostedStreamFn({ fetchImpl, retryBaseDelayMs: 1 });
    const events = await drain(streamFn(ctx, opts()));

    const done = events.find((e) => e.type === 'done') as Extract<AssistantMessageEvent, { type: 'done' }>;
    expect(done).toBeDefined();
    expect(done.message.content[0]).toEqual({ type: 'text', text: 'hello' });
    expect(done.message.stopReason).toBe('stop');
    expect(calls).toBe(2);
  });

  it('retries after a network-error throw and succeeds on the second attempt', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) throw new Error('network error');
      return sseResponse(['data: {"type":"text","content":"hello"}\n\n', 'data: [DONE]\n\n']);
    }) as unknown as typeof fetch;

    const streamFn = createHostedStreamFn({ fetchImpl, retryBaseDelayMs: 1 });
    const events = await drain(streamFn(ctx, opts()));

    const done = events.find((e) => e.type === 'done') as Extract<AssistantMessageEvent, { type: 'done' }>;
    expect(done.message.content[0]).toEqual({ type: 'text', text: 'hello' });
    expect(calls).toBe(2);
  });

  it('gives up after maxAttempts consecutive 502s and emits only an error event', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('error code: 1031', { status: 502 });
    }) as unknown as typeof fetch;

    const streamFn = createHostedStreamFn({ fetchImpl, retryBaseDelayMs: 1, maxAttempts: 3 });
    const events = await drain(streamFn(ctx, opts()));

    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(calls).toBe(3);
  });

  it('does not retry a non-transient 400 and surfaces a server error', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('bad request', { status: 400 });
    }) as unknown as typeof fetch;

    const streamFn = createHostedStreamFn({ fetchImpl, retryBaseDelayMs: 1 });
    const events = await drain(streamFn(ctx, opts()));

    expect(calls).toBe(1);
    const errorEvent = events.find((e) => e.type === 'error') as Extract<AssistantMessageEvent, { type: 'error' }>;
    expect(errorEvent.error.message).toMatch(/Server error \(400\)/);
  });

  it('does not retry a 401 — logs out and signals an authentication error', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('unauthorized', { status: 401 });
    }) as unknown as typeof fetch;

    const streamFn = createHostedStreamFn({ fetchImpl, retryBaseDelayMs: 1 });
    const events = await drain(streamFn(ctx, opts()));

    expect(calls).toBe(1);
    expect(logoutCalls).toBe(1);
    const errorEvent = events.find((e) => e.type === 'error') as Extract<AssistantMessageEvent, { type: 'error' }>;
    expect(errorEvent.error.message).toMatch(/Authentication expired/);
    expect(authNoticeCalls).toEqual([
      'Your session expired and you were signed out. Sign in again to continue.',
    ]);
  });

  // 403 email_unverified is a VALID session whose mailbox isn't confirmed.
  // Treating it like 401 trapped every email/password signup in a loop:
  // sign in -> first AI message -> 403 -> "session expired", logged out ->
  // sign in -> same 403, forever. Only 401 may end a session.
  it('does not log out on 403 email_unverified — flags verification instead', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: 'email_unverified' }), { status: 403 });
    }) as unknown as typeof fetch;

    const streamFn = createHostedStreamFn({ fetchImpl, retryBaseDelayMs: 1 });
    const events = await drain(streamFn(ctx, opts()));

    expect(calls).toBe(1);
    expect(logoutCalls).toBe(0);
    expect(verificationRequiredCalls).toEqual([true]);
    expect(authNoticeCalls).toEqual([]);
    const errorEvent = events.find((e) => e.type === 'error') as Extract<AssistantMessageEvent, { type: 'error' }>;
    expect(errorEvent.error.message).toMatch(/[Vv]erify your email/);
  });

  // 403 tier_not_available: Deep Think / Max gated to paid plans. Never
  // retried, and folded into a `[code:tier_not_available]` marker so
  // turn-errors.ts routes it to the 'tier_gated' kind (upgrade CTA) rather
  // than the generic 403 fallback or the out-of-credits path.
  it('does not log out on 403 tier_not_available — surfaces a code-marked, non-retriable error', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(
        JSON.stringify({
          error: 'Deep Think and Max are available on paid plans.',
          code: 'tier_not_available',
          requiredPlan: 'pro',
        }),
        { status: 403 },
      );
    }) as unknown as typeof fetch;

    const streamFn = createHostedStreamFn({ fetchImpl, retryBaseDelayMs: 1 });
    const events = await drain(streamFn(ctx, opts()));

    expect(calls).toBe(1);
    expect(logoutCalls).toBe(0);
    expect(verificationRequiredCalls).toEqual([]);
    const errorEvent = events.find((e) => e.type === 'error') as Extract<AssistantMessageEvent, { type: 'error' }>;
    expect(errorEvent.error.message).toBe(
      '[code:tier_not_available] Deep Think and Max are available on paid plans.',
    );
  });

  it('does not log out on a non-verification 403 either', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: 'forbidden_resource' }), { status: 403 });
    }) as unknown as typeof fetch;

    const streamFn = createHostedStreamFn({ fetchImpl, retryBaseDelayMs: 1 });
    const events = await drain(streamFn(ctx, opts()));

    expect(calls).toBe(1);
    expect(logoutCalls).toBe(0);
    expect(verificationRequiredCalls).toEqual([]);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('handles a 403 with a non-JSON body without logging out', async () => {
    const fetchImpl = (async () =>
      new Response('forbidden', { status: 403 })) as unknown as typeof fetch;

    const streamFn = createHostedStreamFn({ fetchImpl, retryBaseDelayMs: 1 });
    const events = await drain(streamFn(ctx, opts()));

    expect(logoutCalls).toBe(0);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('does not retry when the caller signal is already aborted before the first attempt', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      throw new DOMException('The operation was aborted.', 'AbortError');
    }) as unknown as typeof fetch;

    const streamFn = createHostedStreamFn({ fetchImpl, retryBaseDelayMs: 1 });
    const events = await drain(streamFn(ctx, opts(controller.signal)));

    expect(calls).toBe(1);
    const done = events.find((e) => e.type === 'done') as Extract<AssistantMessageEvent, { type: 'done' }>;
    expect(done.message.stopReason).toBe('aborted');
  });

  it('aborts cleanly if the caller signal fires during a backoff wait', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('bad gateway', { status: 502 });
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const streamFn = createHostedStreamFn({ fetchImpl, retryBaseDelayMs: 500 });
    const events = await drain(streamFn(ctx, opts(controller.signal)));

    expect(calls).toBe(1); // second attempt never happened — abort fired during the backoff sleep
    const done = events.find((e) => e.type === 'done') as Extract<AssistantMessageEvent, { type: 'done' }>;
    expect(done).toBeDefined();
    expect(done.message.stopReason).toBe('aborted');
  });

  it('fires the idle watchdog when no SSE chunk arrives within the threshold, preserving partial content', async () => {
    let pullCount = 0;
    const fetchImpl = (async () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pullCount++;
          if (pullCount === 1) {
            controller.enqueue(new TextEncoder().encode('data: {"type":"text","content":"hi"}\n\n'));
          }
          // Subsequent pulls: never enqueue again and never close — simulates
          // the documented CF Workers AI stall (no data, connection open).
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    const streamFn = createHostedStreamFn({ fetchImpl, idleTimeoutMs: 20 });
    const events = await drain(streamFn(ctx, opts()));

    const errorEvent = events.find((e) => e.type === 'error') as Extract<AssistantMessageEvent, { type: 'error' }>;
    expect(errorEvent).toBeDefined();
    expect(errorEvent.error.message).toMatch(/stalled/i);
    expect(errorEvent.partial?.content[0]).toEqual({ type: 'text', text: 'hi' });
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('fires the first-token watchdog when the stream connects but never sends a single byte', async () => {
    const fetchImpl = (async () => {
      const body = new ReadableStream<Uint8Array>({
        pull() {
          // Never enqueue, never close — a hung-but-open connect with zero
          // bytes ever sent, distinct from the idle-gap case (which has
          // already delivered at least one chunk).
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    const streamFn = createHostedStreamFn({ fetchImpl, firstTokenTimeoutMs: 20 });
    const events = await drain(streamFn(ctx, opts()));

    const errorEvent = events.find((e) => e.type === 'error') as Extract<AssistantMessageEvent, { type: 'error' }>;
    expect(errorEvent).toBeDefined();
    expect(errorEvent.error.message).toMatch(/stalled before the first token/i);
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('does not retry a failure that happens after the first chunk has already been consumed', async () => {
    let calls = 0;
    let pullCount = 0;
    const fetchImpl = (async () => {
      calls++;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pullCount++;
          if (pullCount === 1) {
            controller.enqueue(new TextEncoder().encode('data: {"type":"text","content":"hi"}\n\n'));
            return;
          }
          // Second read: simulate a mid-stream network drop, *after* the
          // first chunk was already delivered to the caller.
          controller.error(new Error('mid-stream network drop'));
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    const streamFn = createHostedStreamFn({ fetchImpl, retryBaseDelayMs: 1 });
    const events = await drain(streamFn(ctx, opts()));

    expect(calls).toBe(1); // no retry attempted — first byte was already consumed
    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('does not abort a long-lived stream once connected — the connect timer is disarmed after a successful connect (Finding 1 regression guard)', async () => {
    // connectTimeoutMs (50ms) is deliberately much smaller than the stream's
    // total lifetime (~100ms across 5 chunks @ 20ms apart) — each individual
    // gap stays well under the (default, 90s) idle threshold. Before the
    // fix, the old `AbortSignal.timeout(connectTimeoutMs)` kept ticking
    // after a successful connect and aborted the reader once it fired,
    // regardless of how healthy the stream was.
    let calls = 0;
    const fetchImpl = (async (_url: string, init?: { signal?: AbortSignal }) => {
      calls++;
      await sleep(10); // connects well within the 50ms connect timeout
      // Thread the real fetch signal through, same as production's `fetch`
      // would — this is what makes the test capable of catching Finding 1
      // (see `delayedSseResponse`'s doc comment).
      return delayedSseResponse(
        [
          'data: {"type":"text","content":"a"}\n\n',
          'data: {"type":"text","content":"b"}\n\n',
          'data: {"type":"text","content":"c"}\n\n',
          'data: {"type":"text","content":"d"}\n\n',
          'data: {"type":"text","content":"e"}\n\n',
          'data: [DONE]\n\n',
        ],
        20,
        init?.signal,
      );
    }) as unknown as typeof fetch;

    const streamFn = createHostedStreamFn({ fetchImpl, connectTimeoutMs: 50 });
    const events = await drain(streamFn(ctx, opts()));

    expect(calls).toBe(1); // never retried — the connect timer never fired after a successful connect
    expect(events.some((e) => e.type === 'error')).toBe(false);
    const done = events.find((e) => e.type === 'done') as Extract<AssistantMessageEvent, { type: 'done' }>;
    expect(done).toBeDefined();
    const text = done.message.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(text).toBe('abcde');
  });

  it('retries when the connect phase itself exceeds connectTimeoutMs, then succeeds — a timed-out connect is transient, not a caller abort', async () => {
    let calls = 0;
    const fetchImpl = ((_url: string, init?: { signal?: AbortSignal }) => {
      calls++;
      const attemptNumber = calls;
      return new Promise<Response>((resolve, reject) => {
        if (attemptNumber === 1) {
          // Never resolves on its own — only reacts to the connect
          // timeout's own abort signal, same as real `fetch` rejecting once
          // its `AbortController` fires. No caller signal is involved here
          // (`opts()` below passes none), so this must NOT be treated as a
          // caller cancellation — it must fall into the retry path.
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'TimeoutError'));
          });
          return;
        }
        resolve(sseResponse(['data: {"type":"text","content":"hello"}\n\n', 'data: [DONE]\n\n']));
      });
    }) as unknown as typeof fetch;

    const streamFn = createHostedStreamFn({ fetchImpl, connectTimeoutMs: 20, retryBaseDelayMs: 1 });
    const events = await drain(streamFn(ctx, opts()));

    expect(calls).toBe(2); // first attempt's connect-phase timeout fired -> retried, not treated as a caller abort
    const done = events.find((e) => e.type === 'done') as Extract<AssistantMessageEvent, { type: 'done' }>;
    expect(done).toBeDefined();
    expect(done.message.content[0]).toEqual({ type: 'text', text: 'hello' });
  });

  it('records a scripted usage event into turn-telemetry latency and the ai store session-usage counter (P4)', async () => {
    const fetchImpl = (async () =>
      sseResponse([
        'data: {"type":"text","content":"hi"}\n\n',
        'data: {"type":"usage","input_tokens":10,"output_tokens":5}\n\n',
        'data: [DONE]\n\n',
      ])) as unknown as typeof fetch;

    const streamFn = createHostedStreamFn({ fetchImpl });
    const events = await drain(streamFn(ctx, opts()));

    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(sessionUsageCalls).toEqual([{ inputTokens: 10, outputTokens: 5 }]);

    const snapshot = nextTurnTelemetry();
    expect(snapshot.lastTurnLatencyMs).not.toBeNull();
    expect(typeof snapshot.lastTurnLatencyMs).toBe('number');
  });

  it('accumulates session usage across multiple usage events within the same stream', async () => {
    const fetchImpl = (async () =>
      sseResponse([
        'data: {"type":"usage","input_tokens":10,"output_tokens":5}\n\n',
        'data: {"type":"usage","input_tokens":3,"output_tokens":2}\n\n',
        'data: [DONE]\n\n',
      ])) as unknown as typeof fetch;

    const streamFn = createHostedStreamFn({ fetchImpl });
    await drain(streamFn(ctx, opts()));

    expect(sessionUsageCalls).toEqual([
      { inputTokens: 10, outputTokens: 5 },
      { inputTokens: 3, outputTokens: 2 },
    ]);
  });

  it('reports corruption when the stream carries only malformed data: lines before [DONE]', async () => {
    const fetchImpl = (async () =>
      sseResponse([
        'data: not json\n\n',
        'data: {also bad\n\n',
        'data: {"unterminated": \n\n',
        'data: [DONE]\n\n',
      ])) as unknown as typeof fetch;

    const streamFn = createHostedStreamFn({ fetchImpl });
    const events = await drain(streamFn(ctx, opts()));

    expect(events.some((e) => e.type === 'done')).toBe(false);
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents.length).toBe(1);
    const errorEvent = errorEvents[0] as Extract<AssistantMessageEvent, { type: 'error' }>;
    expect(errorEvent.error.message).toMatch(/Response corrupted — 3 unreadable/);
  });

  it('finalizes normally when malformed lines are mixed with real text content', async () => {
    const fetchImpl = (async () =>
      sseResponse([
        'data: not json\n\n',
        'data: {"type":"text","content":"hello"}\n\n',
        'data: also not json\n\n',
        'data: [DONE]\n\n',
      ])) as unknown as typeof fetch;

    const streamFn = createHostedStreamFn({ fetchImpl });
    const events = await drain(streamFn(ctx, opts()));

    expect(events.some((e) => e.type === 'error')).toBe(false);
    const done = events.find((e) => e.type === 'done') as Extract<AssistantMessageEvent, { type: 'done' }>;
    expect(done).toBeDefined();
    expect(done.message.content[0]).toEqual({ type: 'text', text: 'hello' });
  });

  it('a stream that dies without [DONE] after real text surfaces an error, not a complete answer', async () => {
    // Worker eviction / proxy close: the connection ends cleanly but the
    // server never wrote [DONE]. This used to finalize as stopReason 'stop'
    // whenever no tool call was present — a mid-sentence truncated answer
    // rendered as a complete response with no error and no Retry.
    const fetchImpl = (async () =>
      sseResponse(['data: {"type":"text","content":"Half an ans"}\n\n'])) as unknown as typeof fetch;

    const streamFn = createHostedStreamFn({ fetchImpl });
    const events = await drain(streamFn(ctx, opts()));

    expect(events.some((e) => e.type === 'done')).toBe(false);
    const errorEvent = events.find((e) => e.type === 'error') as Extract<AssistantMessageEvent, { type: 'error' }>;
    expect(errorEvent).toBeDefined();
    expect(errorEvent.error.message).toMatch(/ended unexpectedly/);
    expect(errorEvent.partial?.stopReason).toBe('error');
    expect(errorEvent.partial?.content[0]).toEqual({ type: 'text', text: 'Half an ans' });
  });

  it('an empty stream without [DONE] still finalizes as an empty stop (rescued as empty-response downstream)', async () => {
    const fetchImpl = (async () => sseResponse([])) as unknown as typeof fetch;

    const streamFn = createHostedStreamFn({ fetchImpl });
    const events = await drain(streamFn(ctx, opts()));

    const done = events.find((e) => e.type === 'done') as Extract<AssistantMessageEvent, { type: 'done' }>;
    expect(done).toBeDefined();
    expect(done.message.content).toEqual([]);
    expect(done.message.stopReason).toBe('stop');
  });

  it('reports corruption when the reader ends (no [DONE]) with only malformed lines', async () => {
    const fetchImpl = (async () =>
      sseResponse(['data: not json\n\n', 'data: also bad\n\n'])) as unknown as typeof fetch;

    const streamFn = createHostedStreamFn({ fetchImpl });
    const events = await drain(streamFn(ctx, opts()));

    expect(events.some((e) => e.type === 'done')).toBe(false);
    const errorEvent = events.find((e) => e.type === 'error') as Extract<AssistantMessageEvent, { type: 'error' }>;
    expect(errorEvent).toBeDefined();
    expect(errorEvent.error.message).toMatch(/Response corrupted — 2 unreadable/);
  });

  it('propagates a server error code as a bracketed prefix on the error message', async () => {
    const fetchImpl = (async () =>
      sseResponse([
        'data: {"type":"error","code":"rate_limit","message":"slow down"}\n\n',
      ])) as unknown as typeof fetch;

    const streamFn = createHostedStreamFn({ fetchImpl });
    const events = await drain(streamFn(ctx, opts()));

    const errorEvent = events.find((e) => e.type === 'error') as Extract<AssistantMessageEvent, { type: 'error' }>;
    expect(errorEvent).toBeDefined();
    expect(errorEvent.error.message).toBe('[code:rate_limit] slow down');
  });

  // T10 fix wave: a coded error with no `message` field used to fall through
  // to `${event.message}` unguarded, producing the literal string
  // "[code:rate_limit] undefined" instead of a usable fallback.
  it('falls back to "Unknown server error" for a coded error with no message', async () => {
    const fetchImpl = (async () =>
      sseResponse(['data: {"type":"error","code":"rate_limit"}\n\n'])) as unknown as typeof fetch;

    const streamFn = createHostedStreamFn({ fetchImpl });
    const events = await drain(streamFn(ctx, opts()));

    const errorEvent = events.find((e) => e.type === 'error') as Extract<AssistantMessageEvent, { type: 'error' }>;
    expect(errorEvent).toBeDefined();
    expect(errorEvent.error.message).toBe('[code:rate_limit] Unknown server error');
  });

  it('surfaces "not logged in" without ever calling fetch', async () => {
    authState.token = null;
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return sseResponse(['data: [DONE]\n\n']);
    }) as unknown as typeof fetch;

    const streamFn = createHostedStreamFn({ fetchImpl });
    const events = await drain(streamFn(ctx, opts()));

    expect(calls).toBe(0);
    const errorEvent = events.find((e) => e.type === 'error') as Extract<AssistantMessageEvent, { type: 'error' }>;
    expect(errorEvent.error.message).toMatch(/Not logged in/);
  });

  it('fails immediately with an offline error when the connectivity store says offline', async () => {
    useConnectivityStore.getState().setOnline(false);
    try {
      let fetchCalled = false;
      const fetchImpl = (async () => {
        fetchCalled = true;
        throw new Error('unreachable');
      }) as unknown as typeof fetch;

      const streamFn = createHostedStreamFn({ fetchImpl });
      const events = await drain(streamFn(ctx, opts()));

      const errorEvent = events.find((e) => e.type === 'error') as Extract<AssistantMessageEvent, { type: 'error' }>;
      expect(errorEvent).toBeDefined();
      expect(errorEvent.error.message).toContain("You're offline");
      expect(fetchCalled).toBe(false);
    } finally {
      useConnectivityStore.getState().setOnline(true);
    }
  });

  it('a network-level fetch throw flips the connectivity store offline', async () => {
    useConnectivityStore.getState().setOnline(true);
    try {
      const fetchImpl = (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch;

      const streamFn = createHostedStreamFn({ fetchImpl, maxAttempts: 1 });
      await drain(streamFn(ctx, opts()));

      expect(useConnectivityStore.getState().online).toBe(false);
    } finally {
      useConnectivityStore.getState().setOnline(true);
    }
  });

  // Finding 2 regression guard: a fetch rejection caused by the *caller's*
  // abort (Stop button / navigate-away) is not a network failure and must
  // not flip the connectivity store offline — otherwise the next send
  // falsely fast-fails with "You're offline" for up to 30s while fully
  // online. The fake fetchImpl mirrors real `fetch`: it inspects the signal
  // it was actually called with (the combined signal — `options.signal` +
  // the internal connect-timeout controller) and rejects with an AbortError
  // once that signal is aborted, same as a real fetch would.
  it('a fetch rejected by the caller aborting before the call does NOT flip the connectivity store offline', async () => {
    useConnectivityStore.getState().setOnline(true);
    try {
      const controller = new AbortController();
      controller.abort(); // caller (options.signal) already aborted before the call

      const fetchImpl = ((_url: string, init?: { signal?: AbortSignal }) => {
        if (init?.signal?.aborted) {
          return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
        }
        return Promise.reject(new Error('expected the combined signal to already be aborted'));
      }) as unknown as typeof fetch;

      const streamFn = createHostedStreamFn({ fetchImpl, maxAttempts: 1 });
      const events = await drain(streamFn(ctx, opts(controller.signal)));

      expect(useConnectivityStore.getState().online).toBe(true);
      const done = events.find((e) => e.type === 'done') as Extract<AssistantMessageEvent, { type: 'done' }>;
      expect(done).toBeDefined();
      expect(done.message.stopReason).toBe('aborted');
    } finally {
      useConnectivityStore.getState().setOnline(true);
    }
  });

  // Every other test in this file injects `fetchImpl`, so the production
  // default (`?? fetch`) was never exercised. Stored on the config object and
  // invoked as `cfg.fetchImpl(...)`, a bare `fetch` receives the config object
  // as `this` — and WKWebView, which is what Tauri runs on macOS, rejects that
  // with "Can only call Window.fetch on instances of Window". Every chat send
  // died before reaching the network.
  it('calls the default fetch with a global `this`, not the config object', async () => {
    const seenThis: unknown[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = function (this: unknown) {
      seenThis.push(this);
      return Promise.resolve(sseResponse(['data: {"type":"text","content":"hi"}\n', 'data: [DONE]\n']));
    } as unknown as typeof fetch;

    try {
      const streamFn = createHostedStreamFn();
      await drain(streamFn(ctx, opts()));
    } finally {
      globalThis.fetch = original;
    }

    expect(seenThis).toHaveLength(1);
    // WebKit's check is `this instanceof Window`; globalThis is what satisfies it.
    expect(seenThis[0]).toBe(globalThis);
  });

  describe('served-model usage event (Task 10)', () => {
    it('records the served model reported on a usage event into the ai store', async () => {
      const fetchImpl = (async () =>
        sseResponse([
          'data: {"type":"usage","input_tokens":10,"output_tokens":5,"model":"sol-large"}\n\n',
          'data: [DONE]\n\n',
        ])) as unknown as typeof fetch;

      const streamFn = createHostedStreamFn({ fetchImpl });
      await drain(streamFn(ctx, opts()));

      expect(servedModelCalls).toEqual(['sol-large']);
    });

    it('does not call recordServedModel when a usage event carries no model field', async () => {
      const fetchImpl = (async () =>
        sseResponse([
          'data: {"type":"usage","input_tokens":10,"output_tokens":5}\n\n',
          'data: [DONE]\n\n',
        ])) as unknown as typeof fetch;

      const streamFn = createHostedStreamFn({ fetchImpl });
      await drain(streamFn(ctx, opts()));

      expect(servedModelCalls).toEqual([]);
    });
  });

  describe('difficulty metadata FACT (Task 10)', () => {
    it('includes difficulty for high effort + agent promptMode, from the tagged in_progress todo', async () => {
      setSendPromptMode('agent');
      aiState.hostedPlan = [{ status: 'in_progress', difficulty: 'hard' }];
      const { fetchImpl, bodies } = capturingFetchImpl(sseResponse(['data: [DONE]\n\n']));

      const streamFn = createHostedStreamFn({ fetchImpl });
      await drain(streamFn(ctx, opts(undefined, 'high')));

      expect(bodies[0].metadata.difficulty).toBe('hard');
    });

    it('includes difficulty for plan-execution promptMode too, falling back to the first pending todo', async () => {
      setSendPromptMode('plan-execution');
      aiState.hostedPlan = [{ status: 'pending', difficulty: 'easy' }];
      const { fetchImpl, bodies } = capturingFetchImpl(sseResponse(['data: [DONE]\n\n']));

      const streamFn = createHostedStreamFn({ fetchImpl });
      await drain(streamFn(ctx, opts(undefined, 'high')));

      expect(bodies[0].metadata.difficulty).toBe('easy');
    });

    it('omits the difficulty key entirely when effort is not high', async () => {
      setSendPromptMode('agent');
      aiState.hostedPlan = [{ status: 'in_progress', difficulty: 'hard' }];
      const { fetchImpl, bodies } = capturingFetchImpl(sseResponse(['data: [DONE]\n\n']));

      const streamFn = createHostedStreamFn({ fetchImpl });
      await drain(streamFn(ctx, opts(undefined, 'mid')));

      expect(bodies[0].metadata).not.toHaveProperty('difficulty');
    });

    it('omits the difficulty key outside agent/plan-execution promptModes, even at high effort', async () => {
      setSendPromptMode('ask');
      aiState.hostedPlan = [{ status: 'in_progress', difficulty: 'hard' }];
      const { fetchImpl, bodies } = capturingFetchImpl(sseResponse(['data: [DONE]\n\n']));

      const streamFn = createHostedStreamFn({ fetchImpl });
      await drain(streamFn(ctx, opts(undefined, 'high')));

      expect(bodies[0].metadata).not.toHaveProperty('difficulty');
    });

    it('omits the difficulty key when the plan has no tagged in_progress/pending entry', async () => {
      setSendPromptMode('agent');
      aiState.hostedPlan = [{ status: 'done', difficulty: 'hard' }];
      const { fetchImpl, bodies } = capturingFetchImpl(sseResponse(['data: [DONE]\n\n']));

      const streamFn = createHostedStreamFn({ fetchImpl });
      await drain(streamFn(ctx, opts(undefined, 'high')));

      expect(bodies[0].metadata).not.toHaveProperty('difficulty');
    });
  });
});

describe('tool_call argument parsing', () => {
  function toolCallSse(args: string | undefined, finished = true): string[] {
    const event: Record<string, unknown> = { type: 'tool_call', id: 'tc_1', name: 'write', finished };
    if (args !== undefined) event.arguments = args;
    return [`data: ${JSON.stringify(event)}\n\n`, 'data: [DONE]\n\n'];
  }

  async function finalToolCall(lines: string[]) {
    const streamFn = createHostedStreamFn({ fetchImpl: (async () => sseResponse(lines)) as unknown as typeof fetch });
    const events = await drain(streamFn(ctx, opts()));
    const done = events.find((e) => e.type === 'done');
    const content = (done as unknown as { message: { content: Array<Record<string, unknown>> } })
      .message.content;
    return content.find((b) => b.type === 'toolCall') as
      | { arguments: Record<string, unknown>; rawArguments?: string }
      | undefined;
  }

  it('parses well-formed arguments onto the block', async () => {
    const block = await finalToolCall(toolCallSse('{"path":"A.cs","content":"x"}'));
    expect(block?.arguments).toEqual({ path: 'A.cs', content: 'x' });
    expect(block?.rawArguments).toBeUndefined();
  });

  // The `catch` here used to be empty, so `arguments` stayed at the `{}` set on
  // block creation and the tool RAN on it. Keeping the raw text is what lets the
  // loop refuse the call instead (see vendor/tools/validate-args.ts).
  it('keeps the raw text when the arguments are not valid JSON, instead of silently using {}', async () => {
    const block = await finalToolCall(toolCallSse('{"path":"A.cs","cont'));
    expect(block?.rawArguments).toBe('{"path":"A.cs","cont');
    expect(block?.arguments).toEqual({});
  });

  it('treats valid-but-scalar JSON as unusable rather than as arguments', async () => {
    const block = await finalToolCall(toolCallSse('"just a string"'));
    expect(block?.rawArguments).toBe('"just a string"');
  });

  // A zero-parameter tool (unity_play, unity_stop) legitimately arrives with no
  // argument text. That must stay an empty call, not a parse failure.
  it('treats absent argument text as a legitimate zero-argument call', async () => {
    const block = await finalToolCall(toolCallSse(undefined));
    expect(block?.arguments).toEqual({});
    expect(block?.rawArguments).toBeUndefined();
  });

  it('closes the tool-call block even when no argument text arrives', async () => {
    const streamFn = createHostedStreamFn({
      fetchImpl: (async () => sseResponse(toolCallSse(undefined))) as unknown as typeof fetch,
    });
    const events = await drain(streamFn(ctx, opts()));
    // `toolcall_end` used to sit inside `if (event.arguments)`, so an
    // argument-less call never emitted it.
    expect(events.some((e) => e.type === 'toolcall_end')).toBe(true);
  });
});

describe('429 rate-limit messaging', () => {
  async function errorFrom(body: string): Promise<string> {
    const fetchImpl = (async () => new Response(body, { status: 429 })) as unknown as typeof fetch;
    // maxAttempts 1 so the transient-retry path doesn't consume the response.
    const streamFn = createHostedStreamFn({ fetchImpl, retryBaseDelayMs: 1, maxAttempts: 1 });
    const events = await drain(streamFn(ctx, opts()));
    const err = events.find((e) => e.type === 'error') as { error: Error } | undefined;
    return err?.error.message ?? '';
  }

  // The server computes a real reset time for the hourly spend cap; the client
  // replaced it with "wait a moment", which is wrong by up to an hour and sends
  // the user straight back into another 429.
  it('surfaces the server’s reset-time hint', async () => {
    const msg = await errorFrom(
      JSON.stringify({ code: 'rate_limited', error: 'Too many AI requests in a short window. Try again in ~47 minute(s).' }),
    );
    expect(msg).toContain('~47 minute(s)');
  });

  it('keeps the prefix that classifyTurnError routes on', async () => {
    const msg = await errorFrom(JSON.stringify({ error: 'Try again in ~3 minute(s).' }));
    expect(msg.toLowerCase()).toContain('rate limit');
  });

  it('falls back to the generic message when the body is not JSON', async () => {
    const msg = await errorFrom('<html>429 Too Many Requests</html>');
    expect(msg).toContain('Rate limit exceeded');
    expect(msg).toContain('wait a moment');
  });
});
