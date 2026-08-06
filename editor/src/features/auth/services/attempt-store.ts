// Persists the ONE pending browser-login attempt so that a deep link which
// LAUNCHED the app can still complete a sign-in.
//
// Why persisting a PKCE verifier is acceptable here: auth-client.ts already
// writes the 30-day session JWT into this same app-data directory (via the
// `auth_write_token` Rust command). A 10-minute verifier is strictly less
// valuable than the long-lived session token already at rest beside it, and
// without persistence the most common real journey — download the app, sign
// in on the website, get deep-linked back into an app that was never
// running — silently drops the callback and lands the user in a fresh,
// signed-out window with no explanation.
//
// The record is deleted on use, on teardown, and whenever it is found expired.
import { Store } from '@tauri-apps/plugin-store';

const ATTEMPT_FILE = 'auth-attempt.json';
const KEY = 'pending';

export interface PersistedAttempt {
  attemptId: string;
  /** CSRF state echoed by the callback; must match before we trust a code. */
  state: string;
  verifier: string;
  /** Epoch ms. Mirrors the server's 600s attempt TTL. */
  expiresAt: number;
}

// Deliberately NOT memoized (unlike src/utils/persistence.ts): this store is
// touched a handful of times per sign-in, never in a hot path, and holding a
// handle across the process would pin a stale one — which is exactly what a
// cold-start resume must not do.
async function handle(): Promise<Store> {
  return Store.load(ATTEMPT_FILE);
}

export async function savePendingAttempt(attempt: PersistedAttempt): Promise<void> {
  const s = await handle();
  await s.set(KEY, attempt);
  await s.save();
}

/**
 * Null when absent, malformed, or expired. An expired record is DELETED, not
 * merely filtered, so a later call can't resurrect it. `now` is injectable so
 * tests can pin the expiry boundary without sleeping.
 */
export async function loadPendingAttempt(now: number = Date.now()): Promise<PersistedAttempt | null> {
  const s = await handle();
  const raw = (await s.get(KEY)) as Partial<PersistedAttempt> | null | undefined;
  if (!raw
    || typeof raw.attemptId !== 'string'
    || typeof raw.state !== 'string'
    || typeof raw.verifier !== 'string'
    || typeof raw.expiresAt !== 'number') {
    return null;
  }
  if (raw.expiresAt <= now) {
    await clearPendingAttempt();
    return null;
  }
  return raw as PersistedAttempt;
}

export async function clearPendingAttempt(): Promise<void> {
  const s = await handle();
  await s.delete(KEY);
  await s.save();
}
