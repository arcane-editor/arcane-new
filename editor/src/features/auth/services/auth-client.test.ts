import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

// auth-client.ts calls the Tauri `invoke` command (via the private
// `saveToken`) to persist the token file — mock it the same way
// browser-login.test.ts does, since plain `bun test` has no Tauri webview.
// Must be registered BEFORE the dynamic import below, since auth-client.ts
// statically imports `invoke` from '@tauri-apps/api/core'.
let invokeCalls: Array<{ cmd: string; args?: unknown }> = [];
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args?: unknown) => {
    invokeCalls.push({ cmd, args });
    return undefined;
  },
}));

const { authClient } = await import('./auth-client');

// `exchangeEditorCode` calls the global `fetch` directly (not injectable),
// so stub `globalThis.fetch` per test and restore the original afterward.
const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
let fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = async () =>
  new Response(null, { status: 500 });

beforeEach(() => {
  invokeCalls = [];
  fetchCalls = [];
  fetchImpl = async () => new Response(null, { status: 500 });
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, init });
    return fetchImpl(url, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function savedTokenInvokes(): Array<{ cmd: string; args?: unknown }> {
  return invokeCalls.filter((c) => c.cmd === 'auth_write_token');
}

describe('exchangeEditorCode', () => {
  it('200 {token, user} -> success, saves the token via auth_write_token, POSTs the exact URL + body + headers', async () => {
    fetchImpl = async () =>
      jsonResponse({
        token: 'tok-abc123',
        user: { id: 'u1', email: 'dev@example.com', role: 'user', emailVerified: true },
      });

    const result = await authClient.exchangeEditorCode('CODE1', 'VERIFIER1');

    expect(result).toEqual({
      success: true,
      user: { id: 'u1', email: 'dev@example.com', role: 'user', emailVerified: true },
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('https://api.arcaneai.org/v1/auth/editor/exchange');
    expect(fetchCalls[0].init?.method).toBe('POST');
    expect(fetchCalls[0].init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(fetchCalls[0].init?.body as string)).toEqual({
      code: 'CODE1',
      verifier: 'VERIFIER1',
    });

    expect(savedTokenInvokes()).toEqual([
      { cmd: 'auth_write_token', args: { token: 'tok-abc123', email: 'dev@example.com' } },
    ]);
  });

  it('400 {error: "invalid_code"} -> opaque generic failure message, no token saved', async () => {
    fetchImpl = async () => jsonResponse({ error: 'invalid_code' }, 400);

    const result = await authClient.exchangeEditorCode('CODE2', 'VERIFIER2');

    expect(result.success).toBe(false);
    // The server collapses every failure mode (expired, replayed, verifier
    // mismatch) into the same `invalid_code`, and the client must not invent
    // a more specific message than the single generic one it's given.
    expect(result.error).toBe('Invalid or expired code. Start the sign-in again.');
    expect(result.error).not.toMatch(/replay|mismatch/i);
    expect(result.user).toBeUndefined();
    expect(savedTokenInvokes()).toEqual([]);
  });

  it('other non-2xx (500, non-JSON body) -> generic status-coded failure, no token saved', async () => {
    fetchImpl = async () => new Response('<html>Internal Server Error</html>', { status: 500 });

    const result = await authClient.exchangeEditorCode('CODE3', 'VERIFIER3');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Sign-in failed (500)');
    expect(savedTokenInvokes()).toEqual([]);
  });

  it('fetch throws (network error) -> caught failure, no token saved, no unhandled rejection', async () => {
    fetchImpl = async () => {
      throw new Error('network down');
    };

    const result = await authClient.exchangeEditorCode('CODE4', 'VERIFIER4');

    expect(result.success).toBe(false);
    expect(result.error).toBe('network down');
    expect(savedTokenInvokes()).toEqual([]);
  });
});
