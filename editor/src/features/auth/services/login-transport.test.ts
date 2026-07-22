import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Same pattern as browser-login.test.ts: register module mocks BEFORE
// dynamically importing the module under test, since Tauri APIs don't exist
// under plain `bun test` (no webview).
let invokeCalls: string[] = [];
let loopbackPort = 53411;
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) => {
    invokeCalls.push(cmd);
    if (cmd === 'auth_deep_link_scheme') return 'arcane-dev';
    if (cmd === 'auth_loopback_start') return loopbackPort;
    throw new Error(`unexpected invoke: ${cmd}`);
  },
}));

let deepLinkHandler: ((urls: string[]) => void) | null = null;
let deepLinkUnlistened = false;
mock.module('@tauri-apps/plugin-deep-link', () => ({
  onOpenUrl: async (handler: (urls: string[]) => void) => {
    deepLinkHandler = handler;
    return () => {
      deepLinkUnlistened = true;
      deepLinkHandler = null;
    };
  },
}));

let eventName: string | null = null;
let eventHandler: ((e: { payload: unknown }) => void) | null = null;
let eventUnlistened = false;
mock.module('@tauri-apps/api/event', () => ({
  listen: async (name: string, handler: (e: { payload: unknown }) => void) => {
    eventName = name;
    eventHandler = handler;
    return () => {
      eventUnlistened = true;
      eventHandler = null;
    };
  },
}));

const t = await import('./login-transport');

beforeEach(() => {
  invokeCalls = [];
  deepLinkHandler = null;
  deepLinkUnlistened = false;
  eventName = null;
  eventHandler = null;
  eventUnlistened = false;
  loopbackPort = 53411;
});

describe('deepLinkTransport', () => {
  it('sends the scheme param and delivers a matching callback', async () => {
    const seen: Array<{ code: string; state: string }> = [];
    const armed = await t.deepLinkTransport((p) => seen.push(p));

    expect(armed.params).toEqual({ scheme: 'arcane-dev' });
    expect(invokeCalls).toEqual(['auth_deep_link_scheme']);

    deepLinkHandler!(['arcane-dev://auth/callback?code=abc&state=xyz']);
    expect(seen).toEqual([{ code: 'abc', state: 'xyz' }]);
  });

  it('ignores URLs that are not callbacks', async () => {
    const seen: Array<{ code: string; state: string }> = [];
    await t.deepLinkTransport((p) => seen.push(p));

    deepLinkHandler!(['arcane-dev://something-else', 'https://example.com/x']);
    expect(seen).toEqual([]);
  });

  it('unlisten tears down the listener', async () => {
    const armed = await t.deepLinkTransport(() => {});
    armed.unlisten();
    expect(deepLinkUnlistened).toBe(true);
  });
});

describe('loopbackTransport', () => {
  it('binds a port and sends it as redirect_uri', async () => {
    loopbackPort = 61234;
    const armed = await t.loopbackTransport(() => {});

    expect(armed.params).toEqual({ redirect_uri: 'http://127.0.0.1:61234/callback' });
    expect(invokeCalls).toEqual(['auth_loopback_start']);
    expect(eventName).toBe('auth-loopback-callback');
  });

  it('delivers the callback from the Rust event', async () => {
    const seen: Array<{ code: string; state: string }> = [];
    await t.loopbackTransport((p) => seen.push(p));

    eventHandler!({ payload: { code: 'abc', state: 'xyz' } });
    expect(seen).toEqual([{ code: 'abc', state: 'xyz' }]);
  });

  it('ignores a malformed payload rather than delivering a partial callback', async () => {
    const seen: Array<{ code: string; state: string }> = [];
    await t.loopbackTransport((p) => seen.push(p));

    eventHandler!({ payload: { code: 'abc' } });
    eventHandler!({ payload: null });
    eventHandler!({ payload: 'nonsense' });
    expect(seen).toEqual([]);
  });

  it('unlisten tears down the listener', async () => {
    const armed = await t.loopbackTransport(() => {});
    armed.unlisten();
    expect(eventUnlistened).toBe(true);
  });
});

describe('selectTransport', () => {
  it('returns a callable transport', () => {
    expect(typeof t.selectTransport()).toBe('function');
  });

  it('picks loopback exactly when deep links are unsupported', () => {
    expect(t.selectTransport()).toBe(
      t.isDeepLinkSupported() ? t.deepLinkTransport : t.loopbackTransport,
    );
  });
});
