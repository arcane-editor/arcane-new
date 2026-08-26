import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

// browser-login.ts imports Tauri APIs that don't exist under plain `bun test`
// (no webview). Same pattern as hosted-stream.test.ts: register module mocks
// BEFORE dynamically importing the module under test, and capture calls.
let invokeCalls: string[] = [];
const scheme = 'unityide-dev';
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
// Cold-start URLs arrive via getCurrent(), NOT the onOpenUrl event — that
// split is the whole reason resumeFromColdStart has to exist.
let launchUrls: string[] | null = null;
mock.module('@tauri-apps/plugin-deep-link', () => ({
  onOpenUrl: async (handler: (urls: string[]) => void) => {
    callOrder.push('onOpenUrl');
    deepLinkHandler = handler;
    return () => {
      deepLinkHandler = null;
    };
  },
  getCurrent: async () => launchUrls,
}));

// attempt-store persists via tauri-plugin-store, which needs a real webview.
// `mock.module` is PROCESS-global in bun and attempt-store.test.ts mocks this
// same module, so both files agree to keep state on a shared global —
// otherwise whichever factory registers last would strand the other's object.
declare global {
  // eslint-disable-next-line no-var
  var __ATTEMPT_BACKING__: Record<string, unknown>;
  // eslint-disable-next-line no-var
  var __ATTEMPT_SAVES__: number;
}
globalThis.__ATTEMPT_BACKING__ ??= {};
globalThis.__ATTEMPT_SAVES__ ??= 0;

mock.module('@tauri-apps/plugin-store', () => ({
  Store: {
    load: async () => ({
      get: async (k: string) =>
        (k in globalThis.__ATTEMPT_BACKING__ ? globalThis.__ATTEMPT_BACKING__[k] : null),
      set: async (k: string, v: unknown) => { globalThis.__ATTEMPT_BACKING__[k] = v; },
      delete: async (k: string) => { delete globalThis.__ATTEMPT_BACKING__[k]; },
      save: async () => { globalThis.__ATTEMPT_SAVES__++; },
    }),
  },
}));

// beginBrowserLogin registers a server-side attempt before opening the
// browser. Its default implementation is a bare fetch, so stub the global
// rather than threading an override through ~20 existing call sites — this
// also keeps the default path itself under test.
const ATTEMPT_ID = 'attempt-id-1';
let createdChallenges: string[] = [];
const originalFetch = globalThis.fetch;

// login-transport.ts (imported transitively via browser-login.ts) statically
// imports `listen` from here. It's never invoked by anything browser-login.ts
// exercises, but the real @tauri-apps/api/event module needs `transformCallback`
// from the (partially mocked) @tauri-apps/api/core above, so it must be
// mocked too or the static import resolution fails under `bun test`.
mock.module('@tauri-apps/api/event', () => ({
  listen: async () => () => {},
}));

const bl = await import('./browser-login');

function makeHandlers() {
  const calls: Array<{ code: string; verifier: string }> = [];
  const sessions: Array<import('./session-types').Session> = [];
  const errors: string[] = [];
  const handlers: import('./browser-login').BrowserLoginHandlers = {
    onCode: (code, verifier) => {
      calls.push({ code, verifier });
    },
    onSession: (session) => {
      sessions.push(session);
    },
    onError: (message) => {
      errors.push(message);
    },
  };
  return { calls, sessions, errors, handlers };
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
  launchUrls = null;
  globalThis.__ATTEMPT_BACKING__ = {};
  createdChallenges = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { challenge?: string };
    if (body.challenge) createdChallenges.push(body.challenge);
    return new Response(JSON.stringify({ attempt_id: ATTEMPT_ID, expires_in: 600 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
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
      bl.parseCallback('unityide-dev://auth/callback?code=abc&state=xyz', 'unityide-dev'),
    ).toEqual({ code: 'abc', state: 'xyz' });
  });

  it.each([
    ['wrong scheme', 'unityide://auth/callback?code=a&state=s'],
    ['https scheme', 'https://auth/callback?code=a&state=s'],
    ['wrong host', 'unityide-dev://evil/callback?code=a&state=s'],
    ['wrong path', 'unityide-dev://auth/evil?code=a&state=s'],
    ['path suffix', 'unityide-dev://auth/callback-evil?code=a&state=s'],
    ['missing code', 'unityide-dev://auth/callback?state=s'],
    ['missing state', 'unityide-dev://auth/callback?code=a'],
    ['not a url at all', 'garbage'],
  ])('rejects %s', (_name, url) => {
    expect(bl.parseCallback(url, 'unityide-dev')).toBeNull();
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
    expect(url.searchParams.get('scheme')).toBe('unityide-dev');
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(url.searchParams.get('challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('completes on a state-matching callback and consumes the attempt (replay guard)', async () => {
    const { calls, handlers } = makeHandlers();
    await bl.beginBrowserLogin(handlers);
    const h = deepLinkHandler!;
    const url = `unityide-dev://auth/callback?code=C1&state=${sentState()}`;
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
    h(['unityide-dev://auth/callback?code=EVIL&state=WRONG']);
    expect(calls).toHaveLength(0);
    h([`unityide-dev://auth/callback?code=C2&state=${sentState()}`]); // still pending
    expect(calls).toHaveLength(1);
    expect(calls[0].code).toBe('C2');
  });

  it('batch scan: a mismatched-state callback followed by a matching one in the SAME delivery is still consumed', async () => {
    // Regression for the batch-scan regression: onOpenUrl delivers an array;
    // a mismatched-state URL earlier in the batch must not stop the scan
    // before it reaches a later, genuinely matching URL.
    const { calls, handlers } = makeHandlers();
    await bl.beginBrowserLogin(handlers);
    const h = deepLinkHandler!;
    const state = sentState();
    h([
      `unityide-dev://auth/callback?code=EVIL&state=WRONG`,
      `unityide-dev://auth/callback?code=GOOD&state=${state}`,
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].code).toBe('GOOD');
  });

  it('batch scan: a non-parseable URL followed by a valid matching one in the SAME delivery still works', async () => {
    const { calls, handlers } = makeHandlers();
    await bl.beginBrowserLogin(handlers);
    const h = deepLinkHandler!;
    const state = sentState();
    h(['not-a-callback-url', `unityide-dev://auth/callback?code=GOOD2&state=${state}`]);
    expect(calls).toHaveLength(1);
    expect(calls[0].code).toBe('GOOD2');
  });

  it('cancel-then-callback is ignored', async () => {
    const { calls, handlers } = makeHandlers();
    await bl.beginBrowserLogin(handlers);
    const h = deepLinkHandler!;
    const state = sentState();
    bl.cancelBrowserLogin();
    h([`unityide-dev://auth/callback?code=C3&state=${state}`]);
    expect(calls).toHaveLength(0);
  });

  it('restart tears down the previous attempt (old state no longer accepted)', async () => {
    const { calls, handlers } = makeHandlers();
    await bl.beginBrowserLogin(handlers);
    const firstState = sentState();
    await bl.beginBrowserLogin(handlers);
    const h = deepLinkHandler!;
    h([`unityide-dev://auth/callback?code=OLD&state=${firstState}`]);
    expect(calls).toHaveLength(0);
    h([`unityide-dev://auth/callback?code=NEW&state=${sentState()}`]);
    expect(calls).toHaveLength(1);
    expect(calls[0].code).toBe('NEW');
  });

  it('two rapid begins: the loser (superseded mid-await, before `pending` used to exist) tears down its OWN timer — it never fires later', async () => {
    const first = makeHandlers();
    const second = makeHandlers();

    // Fired without awaiting the first — lands the second call's synchronous
    // `teardown()` while the first is still suspended awaiting challengeS256,
    // i.e. exactly the pre-`pending` window the orphaned-timer bug lived in.
    const p1 = bl.beginBrowserLogin(first.handlers, 20);
    const p2 = bl.beginBrowserLogin(second.handlers, 20);
    await Promise.all([p1, p2]);

    // Only the second (winning) attempt ever reaches onOpenUrl/openUrl.
    expect(openedUrls).toHaveLength(1);

    // Wait past the (short) timeout: the second attempt legitimately times
    // out (nothing consumed or cancelled it) and reports its own onError —
    // but the first attempt was superseded long before that point, so its
    // timer must have torn itself down instead of ALSO firing here against
    // an attempt it has nothing to do with (the orphaned-timer bug).
    await new Promise((r) => setTimeout(r, 60));
    expect(first.errors).toHaveLength(0);
    expect(first.calls).toHaveLength(0);
    expect(second.errors).toHaveLength(1);
  });

  it('cancelBrowserLogin landing mid-await (before `pending` used to exist) leaves no orphaned timer', async () => {
    const { calls, errors, handlers } = makeHandlers();

    const p = bl.beginBrowserLogin(handlers, 20);
    bl.cancelBrowserLogin(); // synchronous — races the still-suspended begin
    await p;

    expect(openedUrls).toHaveLength(0); // never got far enough to open a browser
    await new Promise((r) => setTimeout(r, 60));
    expect(errors).toHaveLength(0); // timer torn down, not left to fire later
    expect(calls).toHaveLength(0);
  });

  it('times out, reports an error, and clears the attempt', async () => {
    const { calls, errors, handlers } = makeHandlers();
    await bl.beginBrowserLogin(handlers, 20);
    await new Promise((r) => setTimeout(r, 60));
    expect(errors).toHaveLength(1);
    expect(calls).toHaveLength(0);
    expect(bl.submitManualCode('LATE')).toBe(false);
  });

  it('uses the loopback transport params when deep links are unsupported', async () => {
    // The transport is the seam; inject it directly rather than faking
    // navigator/import.meta.env, which bun:test cannot rewrite per-test.
    const { handlers } = makeHandlers();
    await bl.beginBrowserLogin(handlers, 60_000, async () => ({
      params: { redirect_uri: 'http://127.0.0.1:53411/callback' },
      unlisten: () => {},
    }));

    const url = new URL(openedUrls[0]!);
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:53411/callback');
    expect(url.searchParams.get('scheme')).toBeNull();
    expect(url.searchParams.get('flow')).toBe('editor');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('challenge')).toBeTruthy();
  });

  it('reserved auth params (state/challenge/flow) cannot be clobbered by a transport', async () => {
    // A transport whose params happened to include the reserved keys must NOT
    // be able to overwrite the real CSRF state or PKCE challenge — doing so
    // would disable the only CSRF check in the system.
    const { handlers } = makeHandlers();
    await bl.beginBrowserLogin(handlers, 60_000, async () => ({
      params: {
        state: 'attacker',
        challenge: 'attacker-challenge',
        flow: 'evil',
        redirect_uri: 'http://127.0.0.1:53411/callback',
      },
      unlisten: () => {},
    }));

    const url = new URL(openedUrls[0]!);
    expect(url.searchParams.get('flow')).toBe('editor');
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(url.searchParams.get('state')).not.toBe('attacker');
    expect(url.searchParams.get('challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('challenge')).not.toBe('attacker-challenge');
    // The transport's own (benign) param still comes through.
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:53411/callback');
  });

  it('delivers a loopback callback whose state matches', async () => {
    const { handlers, calls } = makeHandlers();
    let deliver: ((p: { code: string; state: string }) => void) | null = null;
    await bl.beginBrowserLogin(handlers, 60_000, async (onCallback) => {
      deliver = onCallback;
      return { params: { redirect_uri: 'http://127.0.0.1:53411/callback' }, unlisten: () => {} };
    });

    // Read the state off the URL only AFTER beginBrowserLogin resolved — it is
    // generated inside the flow and openUrl happens last.
    const state = new URL(openedUrls[0]!).searchParams.get('state')!;
    deliver!({ code: 'lb-code', state });

    expect(calls.map((c) => c.code)).toEqual(['lb-code']);
  });

  it('ignores a callback whose state does not match', async () => {
    const { handlers, calls } = makeHandlers();
    let deliver: ((p: { code: string; state: string }) => void) | null = null;
    await bl.beginBrowserLogin(handlers, 60_000, async (onCallback) => {
      deliver = onCallback;
      return { params: { redirect_uri: 'http://127.0.0.1:1/callback' }, unlisten: () => {} };
    });

    deliver!({ code: 'evil', state: 'not-the-state' });

    expect(calls).toEqual([]);
    // The attempt must stay live — a mismatched callback is not a teardown.
    expect(bl.submitManualCode('pasted')).toBe(true);
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

describe('attempt registration', () => {
  it('registers a server-side attempt and puts its id in the auth URL', async () => {
    const { handlers } = makeHandlers();
    await bl.beginBrowserLogin(handlers);

    expect(createdChallenges).toHaveLength(1);
    const url = new URL(openedUrls[0]!);
    expect(url.searchParams.get('attempt')).toBe(ATTEMPT_ID);
    // The registered challenge must be the one the URL advertises.
    expect(url.searchParams.get('challenge')).toBe(createdChallenges[0]);
  });

  it('persists the attempt so a cold start can finish it', async () => {
    const { handlers } = makeHandlers();
    await bl.beginBrowserLogin(handlers);

    const stored = globalThis.__ATTEMPT_BACKING__.pending as { attemptId: string; state: string } | undefined;
    expect(stored?.attemptId).toBe(ATTEMPT_ID);
    expect(stored?.state).toBe(new URL(openedUrls[0]!).searchParams.get('state')!);
  });

  it('clears the persisted attempt on cancel', async () => {
    const { handlers } = makeHandlers();
    await bl.beginBrowserLogin(handlers);
    expect(globalThis.__ATTEMPT_BACKING__.pending).toBeDefined();

    bl.cancelBrowserLogin();
    // teardown fires clearPendingAttempt() without awaiting it (it must stay
    // synchronous for callers); that chain is Store.load → delete → save, so
    // let the event loop drain rather than counting microtasks.
    for (let i = 0; i < 20 && globalThis.__ATTEMPT_BACKING__.pending; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(globalThis.__ATTEMPT_BACKING__.pending).toBeUndefined();
  });
});

describe('resumeFromColdStart', () => {
  const persist = (state: string) => {
    globalThis.__ATTEMPT_BACKING__.pending = {
      attemptId: ATTEMPT_ID,
      state,
      verifier: 'ver-1',
      expiresAt: Date.now() + 60_000,
    };
  };

  it('completes a login from a launch URL matching the persisted attempt', async () => {
    persist('st-1');
    launchUrls = [`${scheme}://auth/callback?code=CODE1&state=st-1`];
    const { calls, handlers } = makeHandlers();

    expect(await bl.resumeFromColdStart(handlers)).toBe(true);
    expect(calls).toEqual([{ code: 'CODE1', verifier: 'ver-1' }]);
    // Consumed before delivery — a replayed launch URL finds nothing.
    expect(globalThis.__ATTEMPT_BACKING__.pending).toBeUndefined();
  });

  it('ignores a launch URL whose state does not match', async () => {
    persist('st-1');
    launchUrls = [`${scheme}://auth/callback?code=CODE1&state=WRONG`];
    const { calls, handlers } = makeHandlers();

    expect(await bl.resumeFromColdStart(handlers)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('returns false when there is no launch URL', async () => {
    persist('st-1');
    launchUrls = null;
    const { handlers } = makeHandlers();
    expect(await bl.resumeFromColdStart(handlers)).toBe(false);
  });

  it('returns false when there is a launch URL but no persisted attempt', async () => {
    launchUrls = [`${scheme}://auth/callback?code=CODE1&state=st-1`];
    const { handlers } = makeHandlers();
    // This is the website-initiated case — the caller re-initiates instead.
    expect(await bl.resumeFromColdStart(handlers)).toBe(false);
  });

  it('returns false when the persisted attempt has expired', async () => {
    globalThis.__ATTEMPT_BACKING__.pending = {
      attemptId: ATTEMPT_ID, state: 'st-1', verifier: 'ver-1',
      expiresAt: Date.now() - 1,
    };
    launchUrls = [`${scheme}://auth/callback?code=CODE1&state=st-1`];
    const { handlers } = makeHandlers();
    expect(await bl.resumeFromColdStart(handlers)).toBe(false);
  });

  it('scans past a non-callback deep link to find the real one', async () => {
    persist('st-1');
    launchUrls = [
      `${scheme}://open-project?path=/tmp/x`,
      `${scheme}://auth/callback?code=CODE2&state=st-1`,
    ];
    const { calls, handlers } = makeHandlers();
    expect(await bl.resumeFromColdStart(handlers)).toBe(true);
    expect(calls).toEqual([{ code: 'CODE2', verifier: 'ver-1' }]);
  });
});

describe('hadLaunchUrl', () => {
  it('is true only when the OS launched the app with a deep link', async () => {
    launchUrls = null;
    expect(await bl.hadLaunchUrl()).toBe(false);
    launchUrls = [];
    expect(await bl.hadLaunchUrl()).toBe(false);
    launchUrls = [`${scheme}://auth/callback?code=C&state=S`];
    expect(await bl.hadLaunchUrl()).toBe(true);
  });
});

describe('poll channel', () => {
  const session = {
    token: 'polled-jwt',
    user: {
      id: 9, email: 'poll@example.com', role: 'user',
      emailVerified: true, plan: 'pro', credits: 1400,
    },
  };

  const settle = async (ms = 30) => { await new Promise((r) => setTimeout(r, ms)); };

  it('completes the sign-in when the poll wins, and tears the attempt down', async () => {
    const { sessions, calls, handlers } = makeHandlers();
    let polls = 0;
    await bl.beginBrowserLogin(
      handlers, 60_000, undefined, undefined,
      async () => { polls++; return polls === 1 ? { status: 'pending' } : { status: 'ok', session }; },
      1,
    );

    await settle();
    expect(sessions).toEqual([session]);
    expect(calls).toEqual([]); // no code path involved
    // Consumed: the deep-link channel now finds nothing to deliver into.
    expect(bl.submitManualCode('ANY')).toBe(false);
  });

  it('keeps waiting while the server says pending', async () => {
    const { sessions, handlers } = makeHandlers();
    await bl.beginBrowserLogin(
      handlers, 60_000, undefined, undefined,
      async () => ({ status: 'pending' }), 1,
    );

    await settle();
    expect(sessions).toEqual([]);
    expect(bl.submitManualCode('STILL-PENDING')).toBe(true); // attempt still live
  });

  it('stops polling once the deep link wins the race', async () => {
    const { handlers } = makeHandlers();
    let polls = 0;
    await bl.beginBrowserLogin(
      handlers, 60_000, undefined, undefined,
      async () => { polls++; return { status: 'invalid' }; }, 1,
    );

    // Deep link arrives first and consumes the attempt.
    deepLinkHandler!([`${scheme}://auth/callback?code=C9&state=${sentState()}`]);
    const seen = polls;
    await settle();
    // The interval was cleared by teardown, so the count cannot keep climbing.
    expect(polls).toBe(seen);
  });

  it('does not fire onSession after the attempt was cancelled mid-request', async () => {
    const { sessions, handlers } = makeHandlers();
    await bl.beginBrowserLogin(
      handlers, 60_000, undefined, undefined,
      async () => {
        bl.cancelBrowserLogin(); // superseded while the request is in flight
        return { status: 'ok', session };
      },
      1,
    );

    await settle();
    expect(sessions).toEqual([]);
  });
});
