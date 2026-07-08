import { describe, it, expect, afterEach } from 'bun:test';
import { createEvalStreamFn } from './eval-stream';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockResponse(message: unknown, usage = { prompt_tokens: 10, completion_tokens: 5 }) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message }], usage }), { status: 200 })) as typeof fetch;
}

const ctx = { systemPrompt: 'SYS', messages: [], tools: [] };

describe('createEvalStreamFn', () => {
  it('sends metadata.reasoningLevel in the request body when configured', async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = (async (_url, init) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: {} }),
        { status: 200 },
      );
    }) as typeof fetch;
    const usage = { input: 0, output: 0, requests: 0 };
    const fn = createEvalStreamFn(
      { baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', label: 'test', reasoningLevel: 'high' },
      usage,
    );
    for await (const _ev of fn(ctx as never, { model: { id: 'm', name: 'm', provider: 'eval' } } as never)) {
      // drain
    }
    const body = JSON.parse(capturedBody ?? '{}');
    expect(body.metadata).toEqual({ reasoningLevel: 'high' });
  });

  it('omits metadata entirely when reasoningLevel is not configured', async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = (async (_url, init) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: {} }),
        { status: 200 },
      );
    }) as typeof fetch;
    const usage = { input: 0, output: 0, requests: 0 };
    const fn = createEvalStreamFn({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', label: 'test' }, usage);
    for await (const _ev of fn(ctx as never, { model: { id: 'm', name: 'm', provider: 'eval' } } as never)) {
      // drain
    }
    const body = JSON.parse(capturedBody ?? '{}');
    expect('metadata' in body).toBe(false);
  });

  it('converts a text answer into a done event', async () => {
    mockResponse({ role: 'assistant', content: 'hello' });
    const usage = { input: 0, output: 0, requests: 0 };
    const fn = createEvalStreamFn({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', label: 'test' }, usage);
    const events: unknown[] = [];
    for await (const ev of fn(ctx as never, { model: { id: 'm', name: 'm', provider: 'eval' } } as never)) {
      events.push(ev);
    }
    const done = events.find((e) => (e as { type: string }).type === 'done') as { message: { content: { type: string; text?: string }[]; stopReason: string } };
    expect(done.message.content[0]).toEqual({ type: 'text', text: 'hello' });
    expect(done.message.stopReason).toBe('stop');
    expect(usage).toEqual({ input: 10, output: 5, requests: 1 });
  });

  it('converts tool_calls and sets stopReason toolUse', async () => {
    mockResponse({
      role: 'assistant', content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a.cs"}' } }],
    });
    const usage = { input: 0, output: 0, requests: 0 };
    const fn = createEvalStreamFn({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', label: 'test' }, usage);
    const events: unknown[] = [];
    for await (const ev of fn(ctx as never, { model: { id: 'm', name: 'm', provider: 'eval' } } as never)) events.push(ev);
    const done = events.find((e) => (e as { type: string }).type === 'done') as { message: { content: { type: string; id?: string; name?: string; arguments?: unknown }[]; stopReason: string } };
    expect(done.message.stopReason).toBe('toolUse');
    expect(done.message.content[0]).toEqual({ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.cs' } });
  });

  it('retries once after a transient 500 and succeeds on the second attempt', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return new Response('3021: rate limiting: inference request per min rate reached', { status: 500 });
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'hello' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const usage = { input: 0, output: 0, requests: 0 };
    const fn = createEvalStreamFn(
      { baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', label: 'test', retryBaseDelayMs: 1 },
      usage,
    );
    const events: unknown[] = [];
    for await (const ev of fn(ctx as never, { model: { id: 'm', name: 'm', provider: 'eval' } } as never)) events.push(ev);
    const done = events.find((e) => (e as { type: string }).type === 'done') as { message: { content: { type: string; text?: string }[] } };
    expect(done.message.content[0]).toEqual({ type: 'text', text: 'hello' });
    expect(calls).toBe(2);
    expect(usage).toEqual({ input: 10, output: 5, requests: 2 });
  });

  it('gives up after maxAttempts consecutive 500s and emits only an error event', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('error code: 502', { status: 502 });
    }) as typeof fetch;
    const usage = { input: 0, output: 0, requests: 0 };
    const fn = createEvalStreamFn(
      { baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', label: 'test', retryBaseDelayMs: 1, maxAttempts: 3 },
      usage,
    );
    const events: unknown[] = [];
    for await (const ev of fn(ctx as never, { model: { id: 'm', name: 'm', provider: 'eval' } } as never)) events.push(ev);
    expect(events.some((e) => (e as { type: string }).type === 'done')).toBe(false);
    expect(events.some((e) => (e as { type: string }).type === 'error')).toBe(true);
    expect(calls).toBe(3);
    expect(usage.requests).toBe(3);
  });

  it('retries after generic fetch-throw errors and succeeds on the third attempt', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls < 3) throw new Error('network error');
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'hello' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const usage = { input: 0, output: 0, requests: 0 };
    const fn = createEvalStreamFn(
      { baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', label: 'test', retryBaseDelayMs: 1, maxAttempts: 3 },
      usage,
    );
    const events: unknown[] = [];
    for await (const ev of fn(ctx as never, { model: { id: 'm', name: 'm', provider: 'eval' } } as never)) events.push(ev);
    const done = events.find((e) => (e as { type: string }).type === 'done') as { message: { content: { type: string; text?: string }[] } };
    expect(done.message.content[0]).toEqual({ type: 'text', text: 'hello' });
    expect(calls).toBe(3);
    expect(usage.requests).toBe(3);
  });

  it('does not retry when the caller signal is already aborted, and does not clobber the AbortError', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new DOMException('The operation was aborted.', 'AbortError');
    }) as typeof fetch;
    const usage = { input: 0, output: 0, requests: 0 };
    const fn = createEvalStreamFn(
      { baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', label: 'test', retryBaseDelayMs: 1 },
      usage,
    );
    const events: unknown[] = [];
    for await (const ev of fn(
      ctx as never,
      { model: { id: 'm', name: 'm', provider: 'eval' }, signal: controller.signal } as never,
    )) {
      events.push(ev);
    }
    expect(events.some((e) => (e as { type: string }).type === 'done')).toBe(false);
    const errorEvent = events.find((e) => (e as { type: string }).type === 'error') as { error: Error };
    expect(errorEvent.error.name).toBe('AbortError');
    expect(calls).toBe(1);
    expect(usage.requests).toBe(1);
  });

  it('defaults to max_tokens: 8192 when no requestState is supplied (back-compat for direct constructions)', async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = (async (_url, init) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: {} }),
        { status: 200 },
      );
    }) as typeof fetch;
    const usage = { input: 0, output: 0, requests: 0 };
    const fn = createEvalStreamFn({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', label: 'test' }, usage);
    for await (const _ev of fn(ctx as never, { model: { id: 'm', name: 'm', provider: 'eval' } } as never)) {
      // drain
    }
    const body = JSON.parse(capturedBody ?? '{}');
    expect(body.max_tokens).toBe(8192);
  });

  it('sends max_tokens from requestState.maxTokens (ask-mode value) when supplied', async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = (async (_url, init) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: {} }),
        { status: 200 },
      );
    }) as typeof fetch;
    const usage = { input: 0, output: 0, requests: 0 };
    const requestState = { maxTokens: 16384 };
    const fn = createEvalStreamFn(
      { baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', label: 'test' },
      usage,
      requestState,
    );
    for await (const _ev of fn(ctx as never, { model: { id: 'm', name: 'm', provider: 'eval' } } as never)) {
      // drain
    }
    const body = JSON.parse(capturedBody ?? '{}');
    expect(body.max_tokens).toBe(16384);
  });

  it('reads requestState.maxTokens fresh per request, reflecting an in-between mutation (agent-mode value)', async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = (async (_url, init) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: {} }),
        { status: 200 },
      );
    }) as typeof fetch;
    const usage = { input: 0, output: 0, requests: 0 };
    const requestState = { maxTokens: 16384 };
    const fn = createEvalStreamFn(
      { baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', label: 'test' },
      usage,
      requestState,
    );
    requestState.maxTokens = 24576; // simulate run-task.ts switching to an agent-mode task
    for await (const _ev of fn(ctx as never, { model: { id: 'm', name: 'm', provider: 'eval' } } as never)) {
      // drain
    }
    const body = JSON.parse(capturedBody ?? '{}');
    expect(body.max_tokens).toBe(24576);
  });

  it('does not retry a non-retryable 4xx response', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('bad request: invalid schema', { status: 400 });
    }) as typeof fetch;
    const usage = { input: 0, output: 0, requests: 0 };
    const fn = createEvalStreamFn(
      { baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', label: 'test', retryBaseDelayMs: 1 },
      usage,
    );
    const events: unknown[] = [];
    for await (const ev of fn(ctx as never, { model: { id: 'm', name: 'm', provider: 'eval' } } as never)) events.push(ev);
    expect(events.some((e) => (e as { type: string }).type === 'error')).toBe(true);
    expect(calls).toBe(1);
    expect(usage.requests).toBe(1);
  });
});
