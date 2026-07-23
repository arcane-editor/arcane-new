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
import type { UnlistenFn } from '@tauri-apps/api/event';
import { ARCANE_WEB_URL } from '../../../config/api';
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

interface PendingAttempt {
  /** Monotonic id of this attempt (see `attemptSeq`). Lets an attempt that's
   * still awaiting something tell — when it resumes — whether it's still the
   * live one or was superseded by a cancel/restart while it was suspended. */
  epoch: number;
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

  pending = { epoch, state, verifier, url: '', handlers, unlisten: null, timer };

  const challenge = await challengeS256(verifier);
  if (pending?.epoch !== epoch) {
    // Superseded (cancel or restart) while awaiting the challenge hash.
    // `pending` now belongs to a different attempt (or is null) — clear only
    // THIS attempt's own timer, never whatever is current.
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
  const params = new URLSearchParams({ ...armed.params, flow: 'editor', state, challenge });
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
