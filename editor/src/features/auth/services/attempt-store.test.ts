import { describe, it, expect, beforeEach, mock } from 'bun:test';

// attempt-store.ts uses tauri-plugin-store's `Store.load`, which needs a real
// Tauri webview. Mock the module before the dynamic import below, following
// the pattern in auth-client.test.ts / browser-login.test.ts.
let backing: Record<string, unknown> = {};
let saveCalls = 0;
mock.module('@tauri-apps/plugin-store', () => ({
  Store: {
    load: async () => ({
      get: async (k: string) => (k in backing ? backing[k] : null),
      set: async (k: string, v: unknown) => { backing[k] = v; },
      delete: async (k: string) => { delete backing[k]; },
      save: async () => { saveCalls++; },
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
    backing = {};
    saveCalls = 0;
  });

  it('round-trips a pending attempt', async () => {
    await savePendingAttempt(attempt);
    expect(await loadPendingAttempt(1000)).toEqual(attempt);
  });

  it('persists through save() so a cold start can read it back', async () => {
    await savePendingAttempt(attempt);
    expect(saveCalls).toBeGreaterThan(0);
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
      backing = { pending: bad };
      expect(await loadPendingAttempt(1000)).toBeNull();
    }
  });
});
