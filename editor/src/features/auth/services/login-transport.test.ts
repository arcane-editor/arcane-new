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
    if (cmd === 'auth_loopback_stop') return undefined;
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
    const armed = await t.deepLinkTransport((p) => {
      seen.push(p);
      return true;
    });

    expect(armed.params).toEqual({ scheme: 'arcane-dev' });
    expect(invokeCalls).toEqual(['auth_deep_link_scheme']);

    deepLinkHandler!(['arcane-dev://auth/callback?code=abc&state=xyz']);
    expect(seen).toEqual([{ code: 'abc', state: 'xyz' }]);
  });

  it('ignores URLs that are not callbacks', async () => {
    const seen: Array<{ code: string; state: string }> = [];
    await t.deepLinkTransport((p) => {
      seen.push(p);
      return true;
    });

    deepLinkHandler!(['arcane-dev://something-else', 'https://example.com/x']);
    expect(seen).toEqual([]);
  });

  it('keeps scanning the batch when onCallback returns false (not consumed), stops at the first true', async () => {
    const seen: Array<{ code: string; state: string }> = [];
    await t.deepLinkTransport((p) => {
      seen.push(p);
      return p.state === 'match'; // only the second URL below "matches"
    });

    deepLinkHandler!([
      'arcane-dev://auth/callback?code=a&state=no-match',
      'arcane-dev://auth/callback?code=b&state=match',
      'arcane-dev://auth/callback?code=c&state=match', // must NOT be inspected — scan stopped at b
    ]);
    expect(seen).toEqual([
      { code: 'a', state: 'no-match' },
      { code: 'b', state: 'match' },
    ]);
  });

  it('unlisten tears down the listener', async () => {
    const armed = await t.deepLinkTransport(() => true);
    armed.unlisten();
    expect(deepLinkUnlistened).toBe(true);
  });
});

describe('loopbackTransport', () => {
  it('binds a port and sends it as redirect_uri', async () => {
    loopbackPort = 61234;
    const armed = await t.loopbackTransport(() => true);

    expect(armed.params).toEqual({ redirect_uri: 'http://127.0.0.1:61234/callback' });
    expect(invokeCalls).toEqual(['auth_loopback_start']);
    expect(eventName).toBe('auth-loopback-callback');
  });

  it('delivers the callback from the Rust event', async () => {
    const seen: Array<{ code: string; state: string }> = [];
    await t.loopbackTransport((p) => {
      seen.push(p);
      return true;
    });

    eventHandler!({ payload: { code: 'abc', state: 'xyz' } });
    expect(seen).toEqual([{ code: 'abc', state: 'xyz' }]);
  });

  it('ignores a malformed payload rather than delivering a partial callback', async () => {
    const seen: Array<{ code: string; state: string }> = [];
    await t.loopbackTransport((p) => {
      seen.push(p);
      return true;
    });

    eventHandler!({ payload: { code: 'abc' } });
    eventHandler!({ payload: null });
    eventHandler!({ payload: 'nonsense' });
    expect(seen).toEqual([]);
  });

  it('unlisten tears down the event listener AND closes the Rust listener', async () => {
    loopbackPort = 61234;
    const armed = await t.loopbackTransport(() => true);
    invokeCalls = []; // ignore the start-time invoke; watch only teardown
    armed.unlisten();
    expect(eventUnlistened).toBe(true);
    // The Rust socket is closed via auth_loopback_stop for the bound port.
    expect(invokeCalls).toEqual(['auth_loopback_stop']);
  });
});

describe('selectTransport', () => {
  it('returns a callable transport', () => {
    expect(typeof t.selectTransport()).toBe('function');
  });

  it('ambient (non-macOS) test-runner UA -> wires through to deepLinkTransport', () => {
    // No mocking here on purpose: `bun test` reports a `Bun/…` user agent,
    // never `Macintosh`, so this exercises the REAL navigator.userAgent /
    // import.meta.env.DEV read path for the "supported" branch end-to-end.
    expect(t.selectTransport()).toBe(t.deepLinkTransport);
  });

  it('macOS + dev (mocked globals) -> wires through to loopbackTransport', () => {
    // Forces the one branch the ambient test UA can never reach, so this
    // pins selectTransport()'s actual wiring of
    // pickTransport(isDeepLinkSupported()) end-to-end, not just its parts.
    const originalUA = navigator.userAgent;
    const originalDev = process.env.DEV;
    Object.defineProperty(navigator, 'userAgent', {
      value: MACOS_UA,
      configurable: true,
    });
    process.env.DEV = 'true';
    try {
      expect(t.selectTransport()).toBe(t.loopbackTransport);
    } finally {
      Object.defineProperty(navigator, 'userAgent', {
        value: originalUA,
        configurable: true,
      });
      if (originalDev === undefined) delete process.env.DEV;
      else process.env.DEV = originalDev;
    }
  });
});

const MACOS_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

describe('deepLinkSupportedFor', () => {
  it('macOS + dev (raw tauri dev binary, unregistered bundle) → NOT supported', () => {
    expect(t.deepLinkSupportedFor(MACOS_UA, true)).toBe(false);
  });

  it('macOS + production build (installed .app bundle) → supported', () => {
    expect(t.deepLinkSupportedFor(MACOS_UA, false)).toBe(true);
  });

  it('Windows/Linux + dev (self-registers at runtime) → supported', () => {
    expect(t.deepLinkSupportedFor(WINDOWS_UA, true)).toBe(true);
  });

  it('Windows/Linux + production → supported', () => {
    expect(t.deepLinkSupportedFor(WINDOWS_UA, false)).toBe(true);
  });
});

describe('pickTransport', () => {
  it('unsupported → loopbackTransport', () => {
    expect(t.pickTransport(false)).toBe(t.loopbackTransport);
  });

  it('supported → deepLinkTransport', () => {
    expect(t.pickTransport(true)).toBe(t.deepLinkTransport);
  });
});
