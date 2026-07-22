// Callback delivery channels for browser sign-in.
//
// The sign-in PROTOCOL (PKCE, one-time code, state check, replay guard) lives
// in browser-login.ts and is identical for every platform. Only the channel the
// callback arrives on varies, and that is what this module owns:
//
//   deepLinkTransport — `arcane://auth/callback?…` via the OS scheme handler.
//     Primary. Needs OS-level registration.
//   loopbackTransport — `http://127.0.0.1:<port>/callback?…` via a one-shot
//     listener in Rust. Used wherever the scheme is not registered (notably
//     macOS `tauri dev`, where the raw debug binary is not a registered bundle).
//
// Both hand back the same `{ code, state }` and the same teardown function, so
// browser-login.ts treats them interchangeably.

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

/** scheme+path only, no query string — a callback URL's query carries the
 * single-use grant code (and CSRF state), so it must never land in a log. */
export function redactUrlForLog(url: string): string {
  const qIndex = url.indexOf('?');
  return qIndex === -1 ? url : url.slice(0, qIndex);
}
