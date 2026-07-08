import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { AssistantMessageEvent, Context, StreamOptions } from './vendor/types';

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
mock.module('../../../stores/ai', () => ({
  useAiStore: {
    getState: () => aiState,
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

beforeEach(() => {
  authState = { token: 'test-token' };
  logoutCalls = 0;
  aiState = { mode: 'ask' };
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
});
