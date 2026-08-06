// Browser-based login via deep link + PKCE (spec Part C2).
//
// Pure helpers (generateState/generateVerifier/challengeS256) are exported for
// unit tests; parseCallback is re-exported from login-transport, where it now
// lives. The stateful flow holds ONE pending attempt in
// module memory. Invariants (spec C2/C5):
//   - the PKCE verifier is MEMORY-ONLY — never persisted; a cold-start deep
//     link therefore cannot complete a login, by design
//   - the deep-link listener exists only while an attempt is pending; it is
//     just `listen('deep-link://new-url', …)` under the hood, so registering
//     it does NOT replay anything. Cold-start/startup URLs are delivered
//     separately via the plugin's `getCurrent()`, which this flow never
//     calls — a cold-start deep link therefore simply finds no pending
//     attempt to match against (nothing to replay, nothing to guard)
//   - the pending attempt is CONSUMED (pending = null, listener + timer torn
//     down) BEFORE code+verifier are handed to `onCode` — a replayed callback
//     URL finds no pending attempt (replay guard)
//   - multi-window: the deep-link event broadcasts to every webview, but only
//     the initiating window's module instance holds a matching `state`, so
//     completion lands in the initiator with no routing logic.
//
// The exchange itself (POST /v1/auth/editor/exchange) is NOT done here — the
// auth store's beginBrowserLogin action supplies `onCode` and owns exchange +
// UI state transitions. That keeps this module free of auth-client/store
// dependencies and fully testable under bun with only Tauri API mocks.
import { openUrl } from '@tauri-apps/plugin-opener';
import { invoke } from '@tauri-apps/api/core';
import { getCurrent } from '@tauri-apps/plugin-deep-link';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { ARCANE_API_URL, ARCANE_WEB_URL } from '../../../config/api';
import {
  savePendingAttempt,
  loadPendingAttempt,
  clearPendingAttempt,
} from './attempt-store';
import {
  parseCallback,
  selectTransport,
  type ArmedTransport,
  type LoginTransport,
  type ParsedCallback,
} from './login-transport';

// Re-exported for back-compat: browser-login.test.ts imports parseCallback
// (and the ParsedCallback type) from here.
export { parseCallback, type ParsedCallback };

// ── Pure helpers ────────────────────────────────────────────────────────────

/** bytes → base64url without padding (RFC 4648 §5). */
export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** CSRF state echoed back in the deep link: base64url(16 random bytes) = 22 chars. */
export function generateState(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

/** PKCE verifier: base64url(32 random bytes) = 43 chars (RFC 7636 minimum). */
export function generateVerifier(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * challenge = base64url(SHA-256(ascii(verifier))) — matches the server's
 * `/^[A-Za-z0-9_-]{43,128}$/` validation on /v1/auth/editor/grant.
 */
export async function challengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

// ── Stateful flow ───────────────────────────────────────────────────────────

export interface BrowserLoginHandlers {
  /**
   * Called at most once per attempt with the one-time grant code and the PKCE
   * verifier, AFTER the pending attempt has been consumed (replay guard).
   * The handler owns the exchange (`authClient.exchangeEditorCode`).
   */
  onCode: (code: string, verifier: string) => void | Promise<void>;
  /** Attempt-level failure (currently: the 10-minute timeout). */
  onError: (message: string) => void;
}

/**
 * Registers a server-side attempt and returns its id. Injected rather than
 * imported from auth-client so this module keeps the property its header
 * claims: no auth-client/store dependencies, testable under bun with only
 * Tauri API mocks. The default is a bare fetch against the same config the
 * auth URL below comes from.
 */
export type CreateAttemptFn = (challenge: string) => Promise<string>;

const defaultCreateAttempt: CreateAttemptFn = async (challenge) => {
  const res = await fetch(`${ARCANE_API_URL}/v1/auth/editor/attempt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge }),
  });
  if (!res.ok) throw new Error(`Could not start sign-in (${res.status})`);
  const data = (await res.json()) as { attempt_id: string };
  return data.attempt_id;
};

interface PendingAttempt {
  /** Monotonic id of this attempt (see `attemptSeq`). Lets an attempt that's
   * still awaiting something tell — when it resumes — whether it's still the
   * live one or was superseded by a cancel/restart while it was suspended. */
  epoch: number;
  /** Server-side attempt id; also what the poll channel consumes against. */
  attemptId: string;
  state: string;
  verifier: string;
  /** Full `${ARCANE_WEB_URL}/auth?…` URL, kept for "Open browser again". */
  url: string;
  handlers: BrowserLoginHandlers;
  unlisten: UnlistenFn | null;
  timer: ReturnType<typeof setTimeout>;
}

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

let pending: PendingAttempt | null = null;
let attemptSeq = 0;

function teardown(): void {
  const p = pending;
  if (!p) return;
  pending = null;
  clearTimeout(p.timer);
  // The persisted copy exists only to let a COLD START finish this attempt.
  // Once the attempt is over — consumed, cancelled, superseded or timed out —
  // it must not survive to be matched by some later, unrelated deep link.
  void clearPendingAttempt().catch(() => {
    /* store unavailable during teardown — the TTL cleans it up regardless */
  });
  if (p.unlisten) {
    try {
      p.unlisten();
    } catch {
      // Listener already gone (window teardown race) — nothing to do.
    }
  }
}

/** Consume the pending attempt FIRST (replay guard), then deliver. */
function consumeAndDeliver(code: string): void {
  const p = pending;
  if (!p) return;
  teardown(); // pending = null BEFORE onCode runs — replayed URLs find nothing
  void p.handlers.onCode(code, p.verifier);
}

/**
 * Start (or restart — any pending attempt is torn down first, spec C5) a
 * browser login. Registers the deep-link listener BEFORE opening the browser
 * so a fast callback cannot be missed. `timeoutMs` is overridable for tests.
 *
 * A placeholder `pending` (with this attempt's `epoch`) is published BEFORE
 * the first await, and re-checked after each subsequent one. This closes a
 * race where a cancel or a second `beginBrowserLogin` landed in the window
 * before `pending` existed yet: it used to be a no-op against THIS attempt,
 * whose own timer then kept running unreferenced and fired its "timed out"
 * error ~10 minutes later against whatever attempt (if any) was live by
 * then. Now every later call's `teardown()` finds a real entry to clear
 * (including this timer) the moment it starts, and if this attempt is
 * already past that point when superseded, the epoch check below catches it
 * and tears down its own timer/listener instead of proceeding.
 */
export async function beginBrowserLogin(
  handlers: BrowserLoginHandlers,
  timeoutMs: number = LOGIN_TIMEOUT_MS,
  transport: LoginTransport = selectTransport(),
  createAttempt: CreateAttemptFn = defaultCreateAttempt,
): Promise<void> {
  teardown();

  const epoch = ++attemptSeq;
  const state = generateState();
  const verifier = generateVerifier();

  const timer = setTimeout(() => {
    if (pending?.epoch !== epoch) return; // zombie timer from a superseded attempt
    teardown();
    handlers.onError('Sign-in timed out. Click "Continue in browser" to try again.');
  }, timeoutMs);

  pending = { epoch, attemptId: '', state, verifier, url: '', handlers, unlisten: null, timer };

  const challenge = await challengeS256(verifier);
  if (pending?.epoch !== epoch) {
    // Superseded (cancel or restart) while awaiting the challenge hash.
    // `pending` now belongs to a different attempt (or is null) — clear only
    // THIS attempt's own timer, never whatever is current.
    clearTimeout(timer);
    return;
  }

  // Register server-side BEFORE opening the browser: the poll channel needs an
  // id to consume against, and persisting it is what lets a deep link that
  // launches a cold app finish this login.
  const attemptId = await createAttempt(challenge);
  if (pending?.epoch !== epoch) {
    clearTimeout(timer);
    return;
  }
  pending.attemptId = attemptId;
  await savePendingAttempt({
    attemptId,
    state,
    verifier,
    expiresAt: Date.now() + timeoutMs,
  });
  if (pending?.epoch !== epoch) {
    clearTimeout(timer);
    return;
  }

  // Arm the transport BEFORE opening the browser so a fast callback cannot be
  // missed. The state comparison lives HERE — one place, both transports.
  // Return value tells the transport whether THIS callback was consumed:
  // deepLinkTransport keeps scanning the rest of an onOpenUrl batch when we
  // return false, instead of stopping at the first parseable-but-mismatched
  // URL (a real match may be later in the same delivery).
  const armed: ArmedTransport = await transport(({ code, state: callbackState }) => {
    if (!pending || pending.epoch !== epoch) return false;
    if (callbackState !== pending.state) {
      // Not a teardown: a mismatched callback is noise (a stale listener, a
      // replayed URL). The real one may still be coming.
      console.warn('[browser-login] callback state mismatch — ignoring');
      return false;
    }
    consumeAndDeliver(code);
    return true;
  });
  if (pending?.epoch !== epoch) {
    // Cancelled or superseded while arming. Guard the unlisten exactly as
    // teardown() does: a throwing unlisten here would reject beginBrowserLogin,
    // and the store's catch would then tear down the SUPERSEDING attempt.
    try {
      armed.unlisten();
    } catch {
      // Listener already gone (window teardown race) — nothing to do.
    }
    clearTimeout(timer);
    return;
  }
  pending.unlisten = armed.unlisten;

  // Spread transport params FIRST so the reserved auth keys (flow/state/
  // challenge) always win — a transport can add its own params (e.g. the
  // loopback redirect_uri) but must never be able to overwrite the CSRF
  // state or the PKCE challenge, which are the entire security of the flow.
  const params = new URLSearchParams({
    ...armed.params, flow: 'editor', state, challenge, attempt: attemptId,
  });
  const url = `${ARCANE_WEB_URL}/auth?${params.toString()}`;
  pending.url = url;

  await openUrl(url);
}

/** Abort the pending attempt: verifier discarded, later callbacks ignored. */
export function cancelBrowserLogin(): void {
  teardown();
}

/** Re-open the SAME auth URL (state/challenge unchanged). False if nothing pending. */
export async function reopenBrowser(): Promise<boolean> {
  const p = pending;
  if (!p) return false;
  await openUrl(p.url);
  return true;
}

/**
 * Manual-paste fallback (spec C2): the code shown on the website's
 * /auth/success page is the SAME one-time grant code the deep link would
 * carry, so it goes through the SAME consume-then-exchange path — PKCE
 * binding to the held verifier preserved. NOT the device flow.
 * Returns false when no attempt is pending (or the code is blank).
 */
export function submitManualCode(code: string): boolean {
  if (!pending) return false;
  const trimmed = code.trim();
  if (!trimmed) return false;
  consumeAndDeliver(trimmed);
  return true;
}

// ── Cold start ──────────────────────────────────────────────────────────────

/**
 * True when the OS launched this process with a deep link.
 *
 * `getCurrent()` is the ONLY way to see a startup URL: the plugin delivers
 * cold-start URLs through it, not through the `new-url` event that the
 * running-process flow listens on. Resolves false when the plugin is
 * unavailable (e.g. a loopback-only dev build).
 */
export async function hadLaunchUrl(): Promise<boolean> {
  try {
    const urls = await getCurrent();
    return !!urls && urls.length > 0;
  } catch {
    return false;
  }
}

/**
 * Complete a login from the URL the OS launched this process with.
 *
 * Returns true when a launch URL matched the PERSISTED attempt and the code
 * was handed to `onCode`. Returns false when there was no launch URL, no
 * persisted attempt (a website-initiated sign-in, an expired attempt, a wiped
 * data dir), or no state match — in which case the caller should fall back to
 * `beginBrowserLogin`, since the browser still holds a session and will
 * complete the re-initiated round-trip without a second login.
 *
 * The persisted attempt is consumed BEFORE delivery, mirroring the in-memory
 * replay guard: a replayed launch URL finds nothing.
 */
export async function resumeFromColdStart(handlers: BrowserLoginHandlers): Promise<boolean> {
  let urls: string[] | null = null;
  try {
    urls = await getCurrent();
  } catch {
    return false;
  }
  if (!urls || urls.length === 0) return false;

  const stored = await loadPendingAttempt().catch(() => null);
  if (!stored) return false;

  let scheme: string;
  try {
    scheme = await invoke<string>('auth_deep_link_scheme');
  } catch {
    return false;
  }

  for (const url of urls) {
    const parsed = parseCallback(url, scheme);
    if (!parsed) continue;
    if (parsed.state !== stored.state) {
      console.warn('[browser-login] cold-start callback state mismatch — ignoring');
      continue;
    }
    await clearPendingAttempt().catch(() => {});
    void handlers.onCode(parsed.code, stored.verifier);
    return true;
  }
  return false;
}
