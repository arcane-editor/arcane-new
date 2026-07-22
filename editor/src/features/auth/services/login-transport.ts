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

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { onOpenUrl } from '@tauri-apps/plugin-deep-link';
import type { UnlistenFn } from '@tauri-apps/api/event';

/** Event the Rust loopback listener emits once it has a callback. */
const LOOPBACK_EVENT = 'auth-loopback-callback';

export interface ArmedTransport {
  /** Query params the website needs in order to reach this listener. */
  params: Record<string, string>;
  /** Tear down the listener. Safe to call more than once. */
  unlisten: UnlistenFn;
}

/**
 * Arms a listener and reports how the website should call back. The listener
 * MUST be live before this resolves — browser-login.ts opens the browser
 * immediately afterwards and a fast callback must not be missed.
 */
export type LoginTransport = (
  onCallback: (parsed: ParsedCallback) => void,
) => Promise<ArmedTransport>;

export const deepLinkTransport: LoginTransport = async (onCallback) => {
  const scheme = await invoke<string>('auth_deep_link_scheme');
  const unlisten = await onOpenUrl((urls: string[]) => {
    for (const url of urls) {
      const parsed = parseCallback(url, scheme);
      if (parsed) {
        onCallback(parsed);
        return;
      }
      console.warn('[browser-login] ignoring non-callback deep link:', redactUrlForLog(url));
    }
  });
  return { params: { scheme }, unlisten };
};

export const loopbackTransport: LoginTransport = async (onCallback) => {
  // Binds before returning, so the port in the URL is always live.
  const port = await invoke<number>('auth_loopback_start');
  const unlisten = await listen<unknown>(LOOPBACK_EVENT, (event) => {
    const p = event.payload as Partial<ParsedCallback> | null;
    // The payload crosses an IPC boundary; treat it as untrusted shape.
    if (!p || typeof p.code !== 'string' || typeof p.state !== 'string') {
      console.warn('[browser-login] ignoring malformed loopback payload');
      return;
    }
    onCallback({ code: p.code, state: p.state });
  });
  return { params: { redirect_uri: `http://127.0.0.1:${port}/callback` }, unlisten };
};

/**
 * Whether the OS will route this build's custom scheme to THIS process.
 *
 * Windows/Linux self-register at runtime (`register_all()` in Rust setup), so
 * even `tauri dev` works there. macOS registers only via an installed .app
 * bundle — under `tauri dev` the raw debug binary is not a registered bundle,
 * so a deep link would launch the (stale) bundled build instead. Loopback
 * covers that case.
 *
 * This picks a TRANSPORT. It must never gate what the user is allowed to see:
 * browser sign-in works on every platform.
 *
 * Pulled out as a pure function of its inputs (`userAgent`, `isDev`) so tests
 * can pin both the macOS-dev and every other case with fixed strings/bools,
 * instead of depending on whatever `navigator.userAgent` happens to be under
 * the test runner (e.g. `bun test` reports `Bun/…`, never `Macintosh`).
 */
export function deepLinkSupportedFor(userAgent: string, isDev: boolean): boolean {
  const isMac = userAgent.includes('Macintosh');
  return !(isMac && isDev);
}

export function isDeepLinkSupported(): boolean {
  return deepLinkSupportedFor(navigator.userAgent, import.meta.env.DEV);
}

/** Pure mapping from the platform decision to a transport — kept separate so
 * tests can pin both branches without touching `navigator`/`import.meta.env`. */
export function pickTransport(deepLinkSupported: boolean): LoginTransport {
  return deepLinkSupported ? deepLinkTransport : loopbackTransport;
}

export function selectTransport(): LoginTransport {
  return pickTransport(isDeepLinkSupported());
}
