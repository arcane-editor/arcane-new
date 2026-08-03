import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { AssistantMessageEvent, Context, StreamOptions } from './vendor/types';
import { sleep } from './stream-retry';
import { resetTurnTelemetry, nextTurnTelemetry } from './turn-telemetry';
import { useConnectivityStore } from '../../../stores/connectivity';

// arcane-stream.ts pulls in `useAuthStore` / `useAiStore`, which (via the
// ai-panel barrel / theme store) transitively touch `document` — fine in the
// real Tauri webview, fatal under plain `bun test` (no DOM). Mock both
// stores at the module level *before* dynamically importing arcane-stream,
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

let aiState: { mode: 'ask' | 'agent' | 'plan' } = { mode: 'ask' };
let sessionUsageCalls: Array<{ inputTokens: number; outputTokens: number }> = [];
let authNoticeCalls: Array<string | null> = [];
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
    }),
  },
}));

const { createArcaneStreamFn } = await import('./arcane-stream');

const ctx: Context = { systemPrompt: 'SYS', messages: [], tools: [] };
function opts(signal?: AbortSignal): StreamOptions {
  return { model: { id: 'm', name: 'm', provider: 'arcane' }, signal };
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
  aiState = { mode: 'ask' };
  sessionUsageCalls = [];
  authNoticeCalls = [];
  resetTurnTelemetry();
  // Several existing tests deliberately throw from fetchImpl to exercise the
  // retry path — since the connect-phase catch now calls
  // `reportFetchFailure()` on every fetch throw, that flips this global
  // zustand store offline as a side effect and would otherwise leak into
  // later tests (whose own fetchImpl would then never even be called, per
  // the new offline fast-fail check). Reset it clean before every test.
  useConnectivityStore.getState().setOnline(true);
});

describe('createArcaneStreamFn', () => {
  it('retries once after a transient 500 and succeeds on the second attempt', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return new Response('3021: rate limiting', { status: 500 });
      return sseResponse(['data: {"type":"text","content":"hello"}\n\n', 'data: [DONE]\n\n']);
    }) as unknown as typeof fetch;

    const streamFn = createArcaneStreamFn({ fetchImpl, retryBaseDelayMs: 1 });
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

    const streamFn = createArcaneStreamFn({ fetchImpl, retryBaseDelayMs: 1 });
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

    const streamFn = createArcaneStreamFn({ fetchImpl, retryBaseDelayMs: 1, maxAttempts: 3 });
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

    const streamFn = createArcaneStreamFn({ fetchImpl, retryBaseDelayMs: 1 });
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

    const streamFn = createArcaneStreamFn({ fetchImpl, retryBaseDelayMs: 1 });
    const events = await drain(streamFn(ctx, opts()));

    expect(calls).toBe(1);
    expect(logoutCalls).toBe(1);
    const errorEvent = events.find((e) => e.type === 'error') as Extract<AssistantMessageEvent, { type: 'error' }>;
    expect(errorEvent.error.message).toMatch(/Authentication expired/);
    expect(authNoticeCalls).toEqual([
      'Your session expired and you were signed out. Sign in again to continue.',
    ]);
  });

  it('does not retry a 403 — logs out and signals an authentication error', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('forbidden', { status: 403 });
    }) as unknown as typeof fetch;

    const streamFn = createArcaneStreamFn({ fetchImpl, retryBaseDelayMs: 1 });
    await drain(streamFn(ctx, opts()));

    expect(calls).toBe(1);
    expect(logoutCalls).toBe(1);
  });

  it('does not retry when the caller signal is already aborted before the first attempt', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      throw new DOMException('The operation was aborted.', 'AbortError');
    }) as unknown as typeof fetch;

    const streamFn = createArcaneStreamFn({ fetchImpl, retryBaseDelayMs: 1 });
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

    const streamFn = createArcaneStreamFn({ fetchImpl, retryBaseDelayMs: 500 });
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

    const streamFn = createArcaneStreamFn({ fetchImpl, idleTimeoutMs: 20 });
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

    const streamFn = createArcaneStreamFn({ fetchImpl, firstTokenTimeoutMs: 20 });
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

    const streamFn = createArcaneStreamFn({ fetchImpl, retryBaseDelayMs: 1 });
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

    const streamFn = createArcaneStreamFn({ fetchImpl, connectTimeoutMs: 50 });
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

    const streamFn = createArcaneStreamFn({ fetchImpl, connectTimeoutMs: 20, retryBaseDelayMs: 1 });
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

    const streamFn = createArcaneStreamFn({ fetchImpl });
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

    const streamFn = createArcaneStreamFn({ fetchImpl });
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

    const streamFn = createArcaneStreamFn({ fetchImpl });
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

    const streamFn = createArcaneStreamFn({ fetchImpl });
    const events = await drain(streamFn(ctx, opts()));

    expect(events.some((e) => e.type === 'error')).toBe(false);
    const done = events.find((e) => e.type === 'done') as Extract<AssistantMessageEvent, { type: 'done' }>;
    expect(done).toBeDefined();
    expect(done.message.content[0]).toEqual({ type: 'text', text: 'hello' });
  });

  it('reports corruption when the reader ends (no [DONE]) with only malformed lines', async () => {
    const fetchImpl = (async () =>
      sseResponse(['data: not json\n\n', 'data: also bad\n\n'])) as unknown as typeof fetch;

    const streamFn = createArcaneStreamFn({ fetchImpl });
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

    const streamFn = createArcaneStreamFn({ fetchImpl });
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

    const streamFn = createArcaneStreamFn({ fetchImpl });
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

    const streamFn = createArcaneStreamFn({ fetchImpl });
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

      const streamFn = createArcaneStreamFn({ fetchImpl });
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

      const streamFn = createArcaneStreamFn({ fetchImpl, maxAttempts: 1 });
      await drain(streamFn(ctx, opts()));

      expect(useConnectivityStore.getState().online).toBe(false);
    } finally {
      useConnectivityStore.getState().setOnline(true);
    }
  });
});
