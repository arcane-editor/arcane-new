import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { BrowserLoginHandlers, ExchangeResult } from '../features/auth';

// stores/auth.ts statically imports both '../features/auth' (the barrel —
// authClient + the browser-login service functions) and '@tauri-apps/api/event'
// (emit). Neither is safe to load for real under plain `bun test` (no Tauri
// webview, and the real barrel also re-exports the AuthTab component). Mock
// both BEFORE the dynamic import of the store below, following the pattern
// `stores/edit-review.test.ts` uses for the ai-panel barrel. No other test
// file imports '../features/auth' or '@tauri-apps/api/event' for real, so
// this mock can't leak into (or be clobbered by) another file's module cache
// entry for the same resolved path.
let exchangeEditorCodeCalls: Array<{ code: string; verifier: string }> = [];
// Type-only import (erased at runtime, so it does NOT defeat the module mock
// below): binds this stub to the REAL contract, so the two can't drift the way
// they did while ExchangeResult was silently missing plan/credits.
let exchangeEditorCodeImpl: (
  code: string,
  verifier: string,
) => Promise<ExchangeResult> = async () => ({ success: false, error: 'not configured' });

let loadFromDiskImpl: () => Promise<{ token: string; email: string } | null> = async () => null;

let beginBrowserLoginCalls: number = 0;
let beginBrowserLoginRejection: Error | null = null;
let capturedHandlers: BrowserLoginHandlers | null = null;

let cancelBrowserLoginCalls: number = 0;

let submitManualCodeCalls: string[] = [];
/** When 'pending', mimics the real service consuming the attempt and
 * delivering onCode with a fixed verifier; when 'none', mimics nothing
 * pending (returns false, same as the real submitManualCode). */
let submitManualCodeMode: 'pending' | 'none' = 'none';

// Cold-start resume: `coldStartResumes` is what resumeFromColdStart reports
// (did a launch URL match a persisted attempt?), `hadLaunchUrlResult` is
// whether the OS launched the app with a deep link at all. The two together
// select resume / re-initiate / do-nothing.
let coldStartCalls = 0;
let coldStartResumes = false;
let hadLaunchUrlResult = false;
let capturedColdStartHandlers: BrowserLoginHandlers | null = null;

mock.module('../features/auth', () => ({
  authClient: {
    exchangeEditorCode: (code: string, verifier: string) => {
      exchangeEditorCodeCalls.push({ code, verifier });
      return exchangeEditorCodeImpl(code, verifier);
    },
    loadFromDisk: () => loadFromDiskImpl(),
    logout: async () => {},
  },
  beginBrowserLogin: async (handlers: BrowserLoginHandlers) => {
    beginBrowserLoginCalls++;
    capturedHandlers = handlers;
    if (beginBrowserLoginRejection) {
      throw beginBrowserLoginRejection;
    }
  },
  cancelBrowserLogin: () => {
    cancelBrowserLoginCalls++;
  },
  resumeFromColdStart: async (handlers: BrowserLoginHandlers) => {
    coldStartCalls++;
    capturedColdStartHandlers = handlers;
    return coldStartResumes;
  },
  hadLaunchUrl: async () => hadLaunchUrlResult,
  submitManualCode: (code: string) => {
    submitManualCodeCalls.push(code);
    if (submitManualCodeMode === 'pending' && capturedHandlers) {
      // Mirrors the real service: the code is trimmed before being handed to
      // onCode (see browser-login.ts's submitManualCode) — the store itself
      // does no trimming of its own.
      void capturedHandlers.onCode(code.trim(), 'manual-verifier');
      return true;
    }
    return false;
  },
}));

// IMPORTANT: `mock.module` replaces a specifier's ENTIRE export surface for
// the rest of the `bun test` process, not just the exports this file cares
// about. `@tauri-apps/api/window.js` (imported for real, unmocked, by
// `utils/persistence.ts` via `getCurrentWindow`) internally does
// `import { listen, once, emit, emitTo, TauriEvent } from './event.js'` —
// the SAME resolved '@tauri-apps/api/event' module this file mocks. A
// factory that only returns `{ emit }` was found (empirically) to break
// `persistence.test.ts` (and other unrelated files) with a link-time
// "Export named 'once' not found" SyntaxError. So every real named export
// must be present here, even though only `emit` needs real spy behavior.
let emitCalls: string[] = [];
mock.module('@tauri-apps/api/event', () => ({
  TauriEvent: {},
  emit: (event: string) => {
    emitCalls.push(event);
    return Promise.resolve();
  },
  emitTo: async () => {},
  listen: async () => () => {},
  once: async () => () => {},
}));

const { useAuthStore } = await import('./auth');

/** Bounded wait for fire-and-forget async transitions (mirrors the helper
 * `stores/edit-review.test.ts` uses for the same kind of glue). */
async function waitFor(predicate: () => boolean, maxMs = 500): Promise<void> {
  const start = Date.now();
  while (!predicate() && Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 5));
  }
  if (!predicate()) {
    throw new Error('waitFor: condition never became true');
  }
}

/** Builds a minimal unsigned JWT-shaped string whose payload has the given
 * `exp` (unix seconds) — enough for the store's own `isJwtExpired` parsing,
 * which only ever reads `parts[1]` as base64url JSON. */
function base64UrlEncode(json: string): string {
  return btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function makeToken(expEpochSeconds: number): string {
  const header = base64UrlEncode(JSON.stringify({ alg: 'none' }));
  const payload = base64UrlEncode(JSON.stringify({ exp: expEpochSeconds }));
  return `${header}.${payload}.sig`;
}

function resetStore(): void {
  useAuthStore.setState({
    loggedIn: false,
    email: null,
    plan: null,
    token: null,
    loginStatus: 'idle',
    error: null,
  });
}

beforeEach(() => {
  resetStore();
  exchangeEditorCodeCalls = [];
  exchangeEditorCodeImpl = async () => ({ success: false, error: 'not configured' });
  loadFromDiskImpl = async () => null;
  beginBrowserLoginCalls = 0;
  beginBrowserLoginRejection = null;
  capturedHandlers = null;
  cancelBrowserLoginCalls = 0;
  submitManualCodeCalls = [];
  submitManualCodeMode = 'none';
  emitCalls = [];
  coldStartCalls = 0;
  coldStartResumes = false;
  hadLaunchUrlResult = false;
  capturedColdStartHandlers = null;
});

describe('useAuthStore.resumeColdStartLogin', () => {
  it('completes the sign-in when a launch URL matched a persisted attempt', async () => {
    coldStartResumes = true;
    exchangeEditorCodeImpl = async () => ({
      success: true,
      user: {
        id: 3, email: 'cold@example.com', role: 'user',
        emailVerified: true, plan: 'pro', credits: 1400,
      },
    });
    loadFromDiskImpl = async () => ({ token: 'cold-tok', email: 'cold@example.com' });

    await useAuthStore.getState().resumeColdStartLogin();
    // The service hands the code straight to the handlers it was given.
    await capturedColdStartHandlers!.onCode('COLD1', 'cold-verifier');

    expect(coldStartCalls).toBe(1);
    const state = useAuthStore.getState();
    expect(state.loggedIn).toBe(true);
    expect(state.email).toBe('cold@example.com');
    expect(state.plan).toBe('pro');
    expect(emitCalls).toEqual(['auth-changed']);
    // Never re-initiates once the resume succeeded.
    expect(beginBrowserLoginCalls).toBe(0);
  });

  it('re-initiates when a launch URL arrived with nothing to match it', async () => {
    coldStartResumes = false;
    hadLaunchUrlResult = true;

    await useAuthStore.getState().resumeColdStartLogin();

    // This is the website-initiated case: the browser already holds a session,
    // so re-opening it completes without a second login.
    expect(beginBrowserLoginCalls).toBe(1);
  });

  it('does nothing when the app was not launched by a deep link', async () => {
    coldStartResumes = false;
    hadLaunchUrlResult = false;

    await useAuthStore.getState().resumeColdStartLogin();

    expect(beginBrowserLoginCalls).toBe(0);
    expect(useAuthStore.getState().loggedIn).toBe(false);
    expect(useAuthStore.getState().error).toBeNull();
  });
});

describe('useAuthStore.beginBrowserLogin', () => {
  it('sets loginStatus to waiting-browser and calls the service with handlers', async () => {
    await useAuthStore.getState().beginBrowserLogin();

    expect(useAuthStore.getState().loginStatus).toBe('waiting-browser');
    expect(useAuthStore.getState().error).toBeNull();
    expect(beginBrowserLoginCalls).toBe(1);
    expect(capturedHandlers).not.toBeNull();
    expect(typeof capturedHandlers!.onCode).toBe('function');
    expect(typeof capturedHandlers!.onError).toBe('function');
  });

  it('onCode -> exchanging, then success -> loggedIn/token/email set, loginStatus idle, auth-changed emitted', async () => {
    await useAuthStore.getState().beginBrowserLogin();

    exchangeEditorCodeImpl = async () => ({
      success: true,
      user: {
        id: 1, email: 'dev@example.com', role: 'user',
        emailVerified: true, plan: 'pro', credits: 1400,
      },
    });
    loadFromDiskImpl = async () => ({ token: 'stored-tok', email: 'dev@example.com' });

    const pending = capturedHandlers!.onCode('CODE1', 'VERIFIER1');
    // Synchronous portion of onCode (the `set` before the first await) has
    // already run by the time the async call returns its pending promise.
    expect(useAuthStore.getState().loginStatus).toBe('exchanging');

    await pending;

    expect(exchangeEditorCodeCalls).toEqual([{ code: 'CODE1', verifier: 'VERIFIER1' }]);
    const state = useAuthStore.getState();
    expect(state.loggedIn).toBe(true);
    expect(state.email).toBe('dev@example.com');
    // The exchange response DOES carry plan + credits — populating them here
    // is what stops the account view flashing "—" until /v1/usage lands.
    expect(state.plan).toBe('pro');
    expect(state.credits).toBe(1400);
    expect(state.token).toBe('stored-tok');
    expect(state.loginStatus).toBe('idle');
    expect(state.error).toBeNull();
    expect(emitCalls).toEqual(['auth-changed']);
  });

  it('onCode -> exchanging, then failure -> loginStatus error with the message, nothing emitted', async () => {
    await useAuthStore.getState().beginBrowserLogin();

    exchangeEditorCodeImpl = async () => ({
      success: false,
      error: 'Invalid or expired code. Start the sign-in again.',
    });

    await capturedHandlers!.onCode('BADCODE', 'VERIFIER1');

    const state = useAuthStore.getState();
    expect(state.loginStatus).toBe('error');
    expect(state.error).toBe('Invalid or expired code. Start the sign-in again.');
    expect(state.loggedIn).toBe(false);
    expect(emitCalls).toEqual([]);
  });

  it('onError handler (attempt-level failure, e.g. the 10-minute timeout) sets loginStatus error with the message', async () => {
    await useAuthStore.getState().beginBrowserLogin();

    capturedHandlers!.onError('Sign-in timed out. Click "Continue in browser" to try again.');

    const state = useAuthStore.getState();
    expect(state.loginStatus).toBe('error');
    expect(state.error).toBe('Sign-in timed out. Click "Continue in browser" to try again.');
  });

  it('begin-throw path (e.g. openUrl rejected): catch sets loginStatus error AND tears down the service — no stuck waiting-browser', async () => {
    beginBrowserLoginRejection = new Error('Could not launch a browser');

    await useAuthStore.getState().beginBrowserLogin();

    const state = useAuthStore.getState();
    expect(state.loginStatus).toBe('error');
    expect(state.loginStatus).not.toBe('waiting-browser');
    expect(state.error).toBe('Could not launch a browser');
    expect(cancelBrowserLoginCalls).toBe(1); // teardown explicitly invoked from the catch
  });
});

describe('useAuthStore.cancelBrowserLogin', () => {
  it('sets loginStatus to idle and tears down the service', async () => {
    await useAuthStore.getState().beginBrowserLogin();
    expect(useAuthStore.getState().loginStatus).toBe('waiting-browser');

    useAuthStore.getState().cancelBrowserLogin();

    expect(useAuthStore.getState().loginStatus).toBe('idle');
    expect(useAuthStore.getState().error).toBeNull();
    expect(cancelBrowserLoginCalls).toBe(1);
  });
});

describe('useAuthStore.submitManualCode', () => {
  it('with a pending attempt: drives the SAME onCode -> exchange path as the deep-link callback', async () => {
    await useAuthStore.getState().beginBrowserLogin();
    submitManualCodeMode = 'pending';
    exchangeEditorCodeImpl = async () => ({
      success: true,
      user: {
        id: 2, email: 'manual@example.com', role: 'user',
        emailVerified: false, plan: 'free', credits: 150,
      },
    });
    loadFromDiskImpl = async () => ({ token: 'manual-tok', email: 'manual@example.com' });

    useAuthStore.getState().submitManualCode('  MANUAL1  ');

    expect(submitManualCodeCalls).toEqual(['  MANUAL1  ']);
    await waitFor(() => useAuthStore.getState().loginStatus === 'idle');

    const state = useAuthStore.getState();
    expect(state.loggedIn).toBe(true);
    expect(state.email).toBe('manual@example.com');
    expect(state.token).toBe('manual-tok');
    expect(exchangeEditorCodeCalls).toEqual([{ code: 'MANUAL1', verifier: 'manual-verifier' }]);
  });

  it('with nothing pending: sets loginStatus error and does not touch exchange', () => {
    submitManualCodeMode = 'none';

    useAuthStore.getState().submitManualCode('NOPE');

    const state = useAuthStore.getState();
    expect(state.loginStatus).toBe('error');
    expect(state.error).toBe('No sign-in attempt in progress — click "Continue in browser" first.');
    expect(exchangeEditorCodeCalls).toEqual([]);
  });
});

describe('useAuthStore.loadFromDisk', () => {
  it('resolves a valid token -> signed-in state set, and a dangling browser-login attempt in THIS window is torn down (Fix 5)', async () => {
    // Simulate: this window had its own attempt in flight when a login
    // completed in ANOTHER window and wrote a fresh token to disk.
    useAuthStore.setState({ loginStatus: 'waiting-browser', error: 'stale' });
    const validToken = makeToken(Math.floor(Date.now() / 1000) + 3600);
    loadFromDiskImpl = async () => ({ token: validToken, email: 'disk@example.com' });

    await useAuthStore.getState().loadFromDisk();

    const state = useAuthStore.getState();
    expect(state.loggedIn).toBe(true);
    expect(state.email).toBe('disk@example.com');
    expect(state.token).toBe(validToken);
    expect(state.loginStatus).toBe('idle');
    expect(state.error).toBeNull();
    // The service's own pending attempt (listener + 10-min timer) must be
    // torn down here, or it later fires a spurious "timed out" error against
    // a window that's already signed in.
    expect(cancelBrowserLoginCalls).toBe(1);
  });

  it('resolves null (token file genuinely missing, e.g. logout in another window) -> resets to signed-out', async () => {
    useAuthStore.setState({ loggedIn: true, email: 'was@example.com', token: 'tok', plan: 'pro' });
    loadFromDiskImpl = async () => null;

    await useAuthStore.getState().loadFromDisk();

    const state = useAuthStore.getState();
    expect(state.loggedIn).toBe(false);
    expect(state.email).toBeNull();
    expect(state.token).toBeNull();
    expect(state.plan).toBeNull();
    expect(state.error).toBeNull();
  });

  it('REJECTS (transient read/parse error, distinct from "no token") -> current session left unchanged (Fix 1 regression guard)', async () => {
    useAuthStore.setState({
      loggedIn: true,
      email: 'still@example.com',
      token: 'still-tok',
      plan: 'pro',
      loginStatus: 'idle',
      error: null,
    });
    loadFromDiskImpl = async () => {
      throw new Error('disk read failed');
    };

    await useAuthStore.getState().loadFromDisk();

    const state = useAuthStore.getState();
    expect(state.loggedIn).toBe(true);
    expect(state.email).toBe('still@example.com');
    expect(state.token).toBe('still-tok');
    expect(state.plan).toBe('pro');
    expect(state.loginStatus).toBe('idle');
  });
});
