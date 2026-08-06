import { describe, it, expect, beforeEach, mock } from 'bun:test';

// attempt-store.ts uses tauri-plugin-store's `Store.load`, which needs a real
// Tauri webview. Mock the module before the dynamic import below, following
// the pattern in auth-client.test.ts / browser-login.test.ts.
//
// `mock.module` is PROCESS-global in bun, and browser-login.test.ts mocks this
// same module. Whichever factory registers last serves both files, so the two
// must agree on where state lives — hence the shared globals rather than a
// file-local object. Each file's beforeEach resets them.
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

const { savePendingAttempt, loadPendingAttempt, clearPendingAttempt } =
  await import('./attempt-store');

const attempt = {
  attemptId: 'att-1',
  state: 'st-1',
  verifier: 'ver-1',
  expiresAt: 2000,
};

describe('attempt-store', () => {
  beforeEach(() => {
    globalThis.__ATTEMPT_BACKING__ = {};
    globalThis.__ATTEMPT_SAVES__ = 0;
  });

  it('round-trips a pending attempt', async () => {
    await savePendingAttempt(attempt);
    expect(await loadPendingAttempt(1000)).toEqual(attempt);
  });

  it('persists through save() so a cold start can read it back', async () => {
    await savePendingAttempt(attempt);
    expect(globalThis.__ATTEMPT_SAVES__).toBeGreaterThan(0);
  });

  it('returns null when nothing is stored', async () => {
    expect(await loadPendingAttempt(1000)).toBeNull();
  });

  it('returns null for an expired attempt AND deletes it', async () => {
    await savePendingAttempt(attempt);
    expect(await loadPendingAttempt(2000)).toBeNull(); // expiresAt <= now
    // Deleted, not merely filtered — an earlier `now` must not resurrect it.
    expect(await loadPendingAttempt(0)).toBeNull();
  });

  it('clears on demand', async () => {
    await savePendingAttempt(attempt);
    await clearPendingAttempt();
    expect(await loadPendingAttempt(1000)).toBeNull();
  });

  it('rejects a malformed record rather than trusting it', async () => {
    for (const bad of [
      { attemptId: 'a', state: 's', verifier: 'v' },              // no expiresAt
      { attemptId: 'a', state: 's', expiresAt: 9999 },            // no verifier
      { state: 's', verifier: 'v', expiresAt: 9999 },             // no attemptId
      { attemptId: 1, state: 's', verifier: 'v', expiresAt: 9999 }, // wrong type
      'not-an-object',
    ]) {
      globalThis.__ATTEMPT_BACKING__ = { pending: bad };
      expect(await loadPendingAttempt(1000)).toBeNull();
    }
  });
});
