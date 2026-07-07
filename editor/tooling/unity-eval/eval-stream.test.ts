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
});
