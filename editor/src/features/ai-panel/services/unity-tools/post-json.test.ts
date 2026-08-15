import { describe, it, expect, afterEach } from 'bun:test';
import { postJsonWithTimeout, FETCH_TIMEOUT_MS } from './post-json';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response>): void {
  globalThis.fetch = impl as unknown as typeof fetch;
}

describe('postJsonWithTimeout', () => {
  it('passes an abort signal to fetch and resolves parsed JSON on success', async () => {
    let sawSignal: AbortSignal | null | undefined;
    mockFetch(async (_url, init) => {
      sawSignal = init.signal as AbortSignal | null | undefined;
      return new Response(JSON.stringify({ hello: 1 }), { status: 200 });
    });
    const out = await postJsonWithTimeout('http://x/api', 'tok', { q: 1 });
    expect(out).toEqual({ ok: true, json: { hello: 1 } });
    expect(sawSignal).toBeInstanceOf(AbortSignal);
  });

  it('maps a non-2xx status to http-<status>', async () => {
    mockFetch(async () => new Response('nope', { status: 503 }));
    const out = await postJsonWithTimeout('http://x/api', 'tok', {});
    expect(out).toEqual({ ok: false, reason: 'http-503' });
  });

  it('maps a timeout abort to offline instead of hanging', async () => {
    mockFetch((_url, init) => {
      // Simulate a server that never responds: reject only when the timeout
      // signal aborts, exactly like undici/WebKit do.
      return new Promise((_resolve, reject) => {
        const sig = init.signal as AbortSignal;
        sig.addEventListener('abort', () => reject(new DOMException('The operation timed out.', 'TimeoutError')), {
          once: true,
        });
      });
    });
    const out = await postJsonWithTimeout('http://x/api', 'tok', {}, 20);
    expect(out).toEqual({ ok: false, reason: 'offline' });
  });

  it('maps a network failure to offline', async () => {
    mockFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const out = await postJsonWithTimeout('http://x/api', 'tok', {});
    expect(out).toEqual({ ok: false, reason: 'offline' });
  });

  it('sends the bearer token and JSON body', async () => {
    let sawInit: RequestInit | undefined;
    mockFetch(async (_url, init) => {
      sawInit = init;
      return new Response('{}', { status: 200 });
    });
    await postJsonWithTimeout('http://x/api', 'secret-token', { a: 'b' });
    expect((sawInit?.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
    expect(sawInit?.body).toBe(JSON.stringify({ a: 'b' }));
  });

  it('has a sane default budget', () => {
    expect(FETCH_TIMEOUT_MS).toBe(10_000);
  });
});
