import { describe, it, expect, beforeEach, mock } from 'bun:test';

// browser-login.ts imports Tauri APIs that don't exist under plain `bun test`
// (no webview). Same pattern as arcane-stream.test.ts: register module mocks
// BEFORE dynamically importing the module under test, and capture calls.
let invokeCalls: string[] = [];
const scheme = 'arcane-dev';
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) => {
    invokeCalls.push(cmd);
    if (cmd === 'auth_deep_link_scheme') return scheme;
    throw new Error(`unexpected invoke: ${cmd}`);
  },
}));

let callOrder: string[] = [];
let openedUrls: string[] = [];
mock.module('@tauri-apps/plugin-opener', () => ({
  openUrl: async (url: string) => {
    callOrder.push('openUrl');
    openedUrls.push(url);
  },
}));

let deepLinkHandler: ((urls: string[]) => void) | null = null;
mock.module('@tauri-apps/plugin-deep-link', () => ({
  onOpenUrl: async (handler: (urls: string[]) => void) => {
    callOrder.push('onOpenUrl');
    deepLinkHandler = handler;
    return () => {
      deepLinkHandler = null;
    };
  },
}));

const bl = await import('./browser-login');

function makeHandlers() {
  const calls: Array<{ code: string; verifier: string }> = [];
  const errors: string[] = [];
  const handlers: import('./browser-login').BrowserLoginHandlers = {
    onCode: (code, verifier) => {
      calls.push({ code, verifier });
    },
    onError: (message) => {
      errors.push(message);
    },
  };
  return { calls, errors, handlers };
}

/** state param of the most recently opened ${WEB}/auth URL. */
function sentState(): string {
  const url = new URL(openedUrls[openedUrls.length - 1]);
  return url.searchParams.get('state')!;
}

beforeEach(() => {
  bl.cancelBrowserLogin(); // reset module-level pending state between tests
  invokeCalls = [];
  callOrder = [];
  openedUrls = [];
  deepLinkHandler = null;
});

describe('generateVerifier', () => {
  it('is exactly 43 chars of base64url (32 random bytes, RFC 7636 minimum)', () => {
    expect(bl.generateVerifier()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('differs between calls', () => {
    expect(bl.generateVerifier()).not.toBe(bl.generateVerifier());
  });
});

describe('generateState', () => {
  it('is 22 chars of base64url (16 random bytes)', () => {
    expect(bl.generateState()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe('challengeS256', () => {
  it('matches the RFC 7636 appendix B known vector', async () => {
    const challenge = await bl.challengeS256(
      'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    );
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('satisfies the server-side challenge regex', async () => {
    const challenge = await bl.challengeS256(bl.generateVerifier());
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  });
});

describe('parseCallback', () => {
  it('parses a valid callback', () => {
    expect(
      bl.parseCallback('arcane-dev://auth/callback?code=abc&state=xyz', 'arcane-dev'),
    ).toEqual({ code: 'abc', state: 'xyz' });
  });

  it.each([
    ['wrong scheme', 'arcane://auth/callback?code=a&state=s'],
    ['https scheme', 'https://auth/callback?code=a&state=s'],
    ['wrong host', 'arcane-dev://evil/callback?code=a&state=s'],
    ['wrong path', 'arcane-dev://auth/evil?code=a&state=s'],
    ['path suffix', 'arcane-dev://auth/callback-evil?code=a&state=s'],
    ['missing code', 'arcane-dev://auth/callback?state=s'],
    ['missing state', 'arcane-dev://auth/callback?code=a'],
    ['not a url at all', 'garbage'],
  ])('rejects %s', (_name, url) => {
    expect(bl.parseCallback(url, 'arcane-dev')).toBeNull();
  });
});

describe('beginBrowserLogin', () => {
  it('registers the deep-link listener BEFORE opening the browser', async () => {
    const { handlers } = makeHandlers();
    await bl.beginBrowserLogin(handlers);
    expect(callOrder).toEqual(['onOpenUrl', 'openUrl']);
    expect(invokeCalls).toContain('auth_deep_link_scheme');
  });

  it('opens ${WEB}/auth with flow=editor, state, S256 challenge, scheme', async () => {
    const { handlers } = makeHandlers();
    await bl.beginBrowserLogin(handlers);
    const url = new URL(openedUrls[0]);
    expect(url.pathname).toBe('/auth');
    expect(url.searchParams.get('flow')).toBe('editor');
    expect(url.searchParams.get('scheme')).toBe('arcane-dev');
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(url.searchParams.get('challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('completes on a state-matching callback and consumes the attempt (replay guard)', async () => {
    const { calls, handlers } = makeHandlers();
    await bl.beginBrowserLogin(handlers);
    const h = deepLinkHandler!;
    const url = `arcane-dev://auth/callback?code=C1&state=${sentState()}`;
    h([url]);
    expect(calls).toHaveLength(1);
    expect(calls[0].code).toBe('C1');
    expect(calls[0].verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(deepLinkHandler).toBeNull(); // listener torn down on consume
    h([url]); // replayed URL — pending already consumed
    expect(calls).toHaveLength(1);
    expect(bl.submitManualCode('C1')).toBe(false); // nothing pending anymore
  });

  it('ignores a state-mismatched callback and stays pending', async () => {
    const { calls, handlers } = makeHandlers();
    await bl.beginBrowserLogin(handlers);
    const h = deepLinkHandler!;
    h(['arcane-dev://auth/callback?code=EVIL&state=WRONG']);
    expect(calls).toHaveLength(0);
    h([`arcane-dev://auth/callback?code=C2&state=${sentState()}`]); // still pending
    expect(calls).toHaveLength(1);
    expect(calls[0].code).toBe('C2');
  });

  it('cancel-then-callback is ignored', async () => {
    const { calls, handlers } = makeHandlers();
    await bl.beginBrowserLogin(handlers);
    const h = deepLinkHandler!;
    const state = sentState();
    bl.cancelBrowserLogin();
    h([`arcane-dev://auth/callback?code=C3&state=${state}`]);
    expect(calls).toHaveLength(0);
  });

  it('restart tears down the previous attempt (old state no longer accepted)', async () => {
    const { calls, handlers } = makeHandlers();
    await bl.beginBrowserLogin(handlers);
    const firstState = sentState();
    await bl.beginBrowserLogin(handlers);
    const h = deepLinkHandler!;
    h([`arcane-dev://auth/callback?code=OLD&state=${firstState}`]);
    expect(calls).toHaveLength(0);
    h([`arcane-dev://auth/callback?code=NEW&state=${sentState()}`]);
    expect(calls).toHaveLength(1);
    expect(calls[0].code).toBe('NEW');
  });

  it('times out, reports an error, and clears the attempt', async () => {
    const { calls, errors, handlers } = makeHandlers();
    await bl.beginBrowserLogin(handlers, 20);
    await new Promise((r) => setTimeout(r, 60));
    expect(errors).toHaveLength(1);
    expect(calls).toHaveLength(0);
    expect(bl.submitManualCode('LATE')).toBe(false);
  });
});

describe('submitManualCode', () => {
  it('delivers the trimmed pasted code with the held verifier (same consume path)', async () => {
    const { calls, handlers } = makeHandlers();
    await bl.beginBrowserLogin(handlers);
    const challenge = new URL(openedUrls[0]).searchParams.get('challenge')!;
    expect(bl.submitManualCode('  MANUAL1  ')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].code).toBe('MANUAL1');
    // PKCE binding preserved: the delivered verifier hashes to the sent challenge.
    expect(await bl.challengeS256(calls[0].verifier)).toBe(challenge);
    expect(bl.submitManualCode('MANUAL1')).toBe(false); // consumed
  });

  it('returns false when nothing is pending', () => {
    expect(bl.submitManualCode('NOPE')).toBe(false);
  });
});

describe('reopenBrowser', () => {
  it('re-opens the SAME url (state/challenge unchanged)', async () => {
    const { handlers } = makeHandlers();
    await bl.beginBrowserLogin(handlers);
    expect(await bl.reopenBrowser()).toBe(true);
    expect(openedUrls).toHaveLength(2);
    expect(openedUrls[1]).toBe(openedUrls[0]);
  });

  it('returns false when nothing is pending', async () => {
    expect(await bl.reopenBrowser()).toBe(false);
  });
});
