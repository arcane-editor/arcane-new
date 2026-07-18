// Browser-based login via deep link + PKCE (spec Part C2).
//
// Pure helpers (generateState/generateVerifier/challengeS256/parseCallback)
// are exported for unit tests. The stateful flow holds ONE pending attempt in
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
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { onOpenUrl } from '@tauri-apps/plugin-deep-link';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { ARCANE_WEB_URL } from '../../../config/api';

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

export interface ParsedCallback {
  code: string;
  state: string;
}

/**
 * Strict parse of `${scheme}://auth/callback?code=…&state=…`. Returns null
 * for anything else (wrong scheme, wrong host/path, missing params).
 * Deliberately string-prefix based instead of `new URL()`: WHATWG parsers
 * disagree across webviews about non-special (custom) schemes, and a prefix
 * check is exact and portable.
 */
export function parseCallback(rawUrl: string, scheme: string): ParsedCallback | null {
  const prefix = `${scheme}://auth/callback`;
  if (!rawUrl.startsWith(prefix)) return null;
  const rest = rawUrl.slice(prefix.length);
  // Allow exactly "" or "?…" — rejects e.g. `arcane://auth/callback-evil`.
  if (rest !== '' && !rest.startsWith('?')) return null;
  const params = new URLSearchParams(rest.startsWith('?') ? rest.slice(1) : '');
  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) return null;
  return { code, state };
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
  state: string;
  verifier: string;
  scheme: string;
  /** Full `${ARCANE_WEB_URL}/auth?…` URL, kept for "Open browser again". */
  url: string;
  handlers: BrowserLoginHandlers;
  unlisten: UnlistenFn | null;
  timer: ReturnType<typeof setTimeout>;
}

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

let pending: PendingAttempt | null = null;

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

function handleDeepLinkUrls(urls: string[]): void {
  for (const url of urls) {
    if (!pending) return; // consumed/cancelled — ignore the rest
    const parsed = parseCallback(url, pending.scheme);
    if (!parsed) {
      console.warn('[browser-login] ignoring non-callback deep link:', url);
      continue;
    }
    if (parsed.state !== pending.state) {
      console.warn('[browser-login] deep link state mismatch — ignoring');
      continue;
    }
    consumeAndDeliver(parsed.code);
    return;
  }
}

/**
 * Start (or restart — any pending attempt is torn down first, spec C5) a
 * browser login. Registers the deep-link listener BEFORE opening the browser
 * so a fast callback cannot be missed. `timeoutMs` is overridable for tests.
 */
export async function beginBrowserLogin(
  handlers: BrowserLoginHandlers,
  timeoutMs: number = LOGIN_TIMEOUT_MS,
): Promise<void> {
  teardown();

  const state = generateState();
  const verifier = generateVerifier();
  const challenge = await challengeS256(verifier);
  const scheme = await invoke<string>('auth_deep_link_scheme');

  const params = new URLSearchParams({ flow: 'editor', state, challenge, scheme });
  const url = `${ARCANE_WEB_URL}/auth?${params.toString()}`;

  const timer = setTimeout(() => {
    teardown();
    handlers.onError('Sign-in timed out. Click "Continue in browser" to try again.');
  }, timeoutMs);

  pending = { state, verifier, scheme, url, handlers, unlisten: null, timer };

  // Register BEFORE openUrl. onOpenUrl is just `listen('deep-link://new-url',
  // …)` — it does NOT replay startup/current URLs on registration; those come
  // only from the plugin's separate `getCurrent()`, which this flow doesn't
  // call. So a cold-start deep link simply finds no pending attempt here.
  const unlisten = await onOpenUrl(handleDeepLinkUrls);
  if (!pending || pending.state !== state) {
    // Cancelled or restarted while awaiting registration.
    unlisten();
    return;
  }
  pending.unlisten = unlisten;

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

/**
 * Deep links need OS-level scheme registration. Windows/Linux self-register at
 * runtime (`register_all()` in Rust setup), so even `tauri dev` works there.
 * macOS registers only via an installed .app bundle — under `tauri dev` on
 * macOS the device-code flow is the default sign-in path instead (spec C3).
 */
export function isBrowserLoginSupported(): boolean {
  const isMac = navigator.userAgent.includes('Macintosh');
  return !(isMac && import.meta.env.DEV);
}
