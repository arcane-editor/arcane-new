# Editor Sign-In Loopback Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make browser sign-in work on every platform — including macOS `tauri dev`, where it is currently unreachable — by adding a loopback HTTP transport alongside the existing deep link, and replace the signed-out `?` avatar with a real Sign In button.

**Architecture:** The sign-in protocol (PKCE, one-time grant code, state check, replay guard) is unchanged. Only the *delivery channel* for the callback becomes pluggable: a `LoginTransport` arms a listener and returns the query params the website needs to reach it. `deepLinkTransport` sends `scheme=arcane-dev` and waits on `onOpenUrl`; `loopbackTransport` binds `127.0.0.1:0` in Rust and sends `redirect_uri=http://127.0.0.1:<port>/callback`. Both terminate in the same `consumeAndDeliver`.

**Tech Stack:** Tauri v2 / Rust (tokio, already a dependency with `net`+`macros`+`time`), React 19 + TypeScript, bun:test (editor), cargo test (Rust), Astro 5 + React islands (landing), vitest (new, landing only).

## Global Constraints

- Branch: `fix/auth-loopback-and-signin`, already created off `dev`. Do not merge to `dev` until the manual checklist in Task 9 passes.
- **No server changes.** `arcane-server/` is not touched by any task. `/v1/auth/editor/grant` and `/v1/auth/editor/exchange` keep their exact current contracts.
- **No new Rust crate.** `tokio` is already declared with `features = ["process","io-util","sync","rt","macros","time","net"]`.
- The Rust side **never validates `state`**. It transports only. The CSRF comparison lives in one place in TypeScript, shared by both transports.
- Loopback binds `127.0.0.1` explicitly — never `0.0.0.0`, never `localhost` (DNS-resolvable, therefore rebindable).
- Deep link stays the primary transport wherever the scheme is registered. Loopback is not a replacement.
- Device-code flow is kept as a last-resort fallback and must remain reachable via the existing "Use a device code instead" link.
- `astro build` does **not** typecheck `.tsx`. Landing typechecking must invoke `tsc` directly.
- Commands: editor tests `bun test src` (from `editor/`), Rust tests `cargo test` (from `editor/src-tauri/`), landing tests `pnpm test` (from `landing-page/`, harness added in Task 4).

## File Structure

**Create:**
- `editor/src-tauri/src/auth_loopback.rs` — one-shot loopback HTTP listener. Owns socket handling and request-line parsing only; emits a Tauri event and exits. No token logic, no state validation.
- `editor/src/features/auth/services/login-transport.ts` — the `LoginTransport` interface plus both implementations and the platform predicate. Owns callback-URL parsing (moved here from `browser-login.ts` — it is a transport concern).
- `editor/src/features/auth/services/login-transport.test.ts` — transport-level tests.
- `landing-page/src/lib/editor-login.test.ts` — validator vectors.
- `landing-page/vitest.config.ts` — test harness config.
- `docs/superpowers/plans/2026-07-22-signin-manual-verification.md` — the merge gate (Task 9).

**Modify:**
- `editor/src-tauri/src/lib.rs` — declare `mod auth_loopback` (after line 16), register `auth_loopback_start` in the invoke handler (near line 774).
- `editor/src/features/auth/services/browser-login.ts` — delegate to a transport; drop the `scheme` field from `PendingAttempt`; re-export `parseCallback`.
- `editor/src/features/auth/services/browser-login.test.ts` — update mocks for the transport indirection.
- `editor/src/features/auth/index.ts` — export `isDeepLinkSupported` instead of `isBrowserLoginSupported`.
- `editor/src/features/auth/components/AuthTab.tsx:25-26,142,307` — remove all three gates.
- `editor/src/features/app-shell/components/TitleBar.tsx:14,48-53` — Sign In button when signed out.
- `editor/src/App.css` — add `.title-bar-signin` next to `.title-bar-avatar` (line ~228).
- `landing-page/src/lib/editor-login.ts` — `redirect_uri` validation, `EditorCallbackTarget` union, `buildCallbackUrl`.
- `landing-page/src/components/auth/AuthHub.tsx:8-11,45-48` — use `buildCallbackUrl`.
- `landing-page/package.json` — vitest devDependency + `test` script.

**Dependency order:** Task 1 (Rust) → Task 3 (transports). Task 4 (landing validator) → Task 5 (landing wiring). Tasks 6, 7 are independent. Task 8 is owner-executed. Task 9 gates the merge.

---

### Task 1: Rust one-shot loopback listener

**Files:**
- Create: `editor/src-tauri/src/auth_loopback.rs`
- Modify: `editor/src-tauri/src/lib.rs` (line 16 area, line 774 area)
- Test: inline `#[cfg(test)] mod tests` in `auth_loopback.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: Tauri command `auth_loopback_start() -> Result<u16, String>` (returns the bound port); event name `"auth-loopback-callback"` with payload `{ code: string, state: string }`; `pub fn parse_request_line(&str) -> Option<LoopbackCallback>`.

- [ ] **Step 1: Write the failing tests**

Create `editor/src-tauri/src/auth_loopback.rs` containing only the test module plus stub signatures:

```rust
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LoopbackCallback {
    pub code: String,
    pub state: String,
}

pub fn parse_request_line(_line: &str) -> Option<LoopbackCallback> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cb(code: &str, state: &str) -> Option<LoopbackCallback> {
        Some(LoopbackCallback { code: code.to_string(), state: state.to_string() })
    }

    #[test]
    fn parses_well_formed_callback() {
        assert_eq!(
            parse_request_line("GET /callback?code=abc123&state=xyz789 HTTP/1.1"),
            cb("abc123", "xyz789")
        );
    }

    #[test]
    fn param_order_does_not_matter() {
        assert_eq!(
            parse_request_line("GET /callback?state=xyz789&code=abc123 HTTP/1.1"),
            cb("abc123", "xyz789")
        );
    }

    #[test]
    fn percent_encoded_values_are_decoded() {
        assert_eq!(
            parse_request_line("GET /callback?code=a%2Bb&state=c%3Dd HTTP/1.1"),
            cb("a+b", "c=d")
        );
    }

    #[test]
    fn extra_params_are_ignored() {
        assert_eq!(
            parse_request_line("GET /callback?code=abc&state=xyz&utm=spam HTTP/1.1"),
            cb("abc", "xyz")
        );
    }

    #[test]
    fn rejects_wrong_path() {
        assert_eq!(parse_request_line("GET /favicon.ico?code=a&state=b HTTP/1.1"), None);
        assert_eq!(parse_request_line("GET /callback-evil?code=a&state=b HTTP/1.1"), None);
    }

    #[test]
    fn rejects_missing_or_empty_params() {
        assert_eq!(parse_request_line("GET /callback?code=abc HTTP/1.1"), None);
        assert_eq!(parse_request_line("GET /callback?state=xyz HTTP/1.1"), None);
        assert_eq!(parse_request_line("GET /callback?code=&state=xyz HTTP/1.1"), None);
        assert_eq!(parse_request_line("GET /callback?code=abc&state= HTTP/1.1"), None);
        assert_eq!(parse_request_line("GET /callback HTTP/1.1"), None);
    }

    #[test]
    fn rejects_non_get_and_junk() {
        assert_eq!(parse_request_line("POST /callback?code=a&state=b HTTP/1.1"), None);
        assert_eq!(parse_request_line(""), None);
        assert_eq!(parse_request_line("garbage"), None);
    }

    #[test]
    fn rejects_malformed_percent_escape() {
        assert_eq!(parse_request_line("GET /callback?code=a%ZZ&state=b HTTP/1.1"), None);
        assert_eq!(parse_request_line("GET /callback?code=a%2&state=b HTTP/1.1"), None);
    }
}
```

Add the module declaration to `editor/src-tauri/src/lib.rs` immediately after line 16 (`mod auth;`):

```rust
mod auth_loopback;
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd editor/src-tauri && cargo test auth_loopback`
Expected: FAIL — 6 of 8 tests fail with `assertion \`left == right\` failed` (the stub returns `None`; `rejects_*` tests pass vacuously).

- [ ] **Step 3: Implement parsing**

Replace the stub `parse_request_line` in `auth_loopback.rs` (keep the test module):

```rust
/// Minimal percent-decoder for query values. `+` is deliberately NOT decoded
/// as space: these values are base64url tokens and `encodeURIComponent` never
/// emits `+`, so treating it as a literal keeps a `+`-bearing code intact.
fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = (bytes[i + 1] as char).to_digit(16)?;
            let lo = (bytes[i + 2] as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Parse `code` + `state` out of an HTTP request line such as
/// `GET /callback?code=abc&state=xyz HTTP/1.1`. Returns None unless the method
/// is GET, the path is exactly `/callback`, and BOTH params are present and
/// non-empty. Anything else is somebody else's request (favicon prefetch, a
/// port scanner) and must not consume the listener's single shot.
pub fn parse_request_line(line: &str) -> Option<LoopbackCallback> {
    let mut parts = line.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    let (path, query) = parts.next()?.split_once('?')?;
    if path != "/callback" {
        return None;
    }
    let mut code = None;
    let mut state = None;
    for pair in query.split('&') {
        let Some((k, v)) = pair.split_once('=') else { continue };
        match k {
            "code" => code = percent_decode(v),
            "state" => state = percent_decode(v),
            _ => {}
        }
    }
    Some(LoopbackCallback {
        code: code.filter(|s| !s.is_empty())?,
        state: state.filter(|s| !s.is_empty())?,
    })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd editor/src-tauri && cargo test auth_loopback`
Expected: PASS — 8 passed.

- [ ] **Step 5: Write the failing socket test**

Append to the `tests` module in `auth_loopback.rs`:

```rust
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    #[tokio::test]
    async fn serves_one_callback_then_stops() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(port >= 1024, "OS must assign a non-privileged ephemeral port");

        let server = tokio::spawn(serve_once(listener));

        let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        client
            .write_all(b"GET /callback?code=abc&state=xyz HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .await
            .unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).await.unwrap();

        assert!(response.starts_with("HTTP/1.1 200 OK"), "got: {response}");
        assert!(!response.contains("abc"), "response must not echo the code");
        assert!(!response.contains("xyz"), "response must not echo the state");
        assert_eq!(
            server.await.unwrap(),
            Some(LoopbackCallback { code: "abc".into(), state: "xyz".into() })
        );

        // Single-use: the listener is dropped, so the port no longer accepts.
        assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
    }

    #[tokio::test]
    async fn non_callback_request_does_not_consume_the_single_shot() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(serve_once(listener));

        // A browser prefetching /favicon.ico must get a 404 and be ignored.
        let mut junk = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        junk.write_all(b"GET /favicon.ico HTTP/1.1\r\n\r\n").await.unwrap();
        let mut junk_response = String::new();
        junk.read_to_string(&mut junk_response).await.unwrap();
        assert!(junk_response.starts_with("HTTP/1.1 404"), "got: {junk_response}");

        // The real callback still lands.
        let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        client
            .write_all(b"GET /callback?code=real&state=s HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        let mut ok = String::new();
        client.read_to_string(&mut ok).await.unwrap();

        assert_eq!(
            server.await.unwrap(),
            Some(LoopbackCallback { code: "real".into(), state: "s".into() })
        );
    }
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd editor/src-tauri && cargo test auth_loopback`
Expected: FAIL — `cannot find function \`serve_once\` in this scope`.

- [ ] **Step 7: Implement the listener and command**

Add to the top of `auth_loopback.rs`, above the test module, and replace the existing `use serde::Serialize;` line with this full header:

```rust
//! One-shot loopback HTTP listener for browser sign-in (RFC 8252 §7.3).
//!
//! Deep links need OS-level scheme registration, which macOS grants only to an
//! installed .app bundle — so under `tauri dev` on macOS a deep link launches
//! the (stale) bundled build rather than the dev process. This listener is the
//! transport used wherever the scheme is not registered: the website redirects
//! the browser to `http://127.0.0.1:<port>/callback?code=…&state=…`, we read
//! the query once, hand it to the frontend as an event, and shut down.
//!
//! This module TRANSPORTS ONLY. It never validates `state` — that comparison
//! lives in browser-login.ts, in one place, shared with the deep-link path.

use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Event carrying the callback params to the frontend.
pub const LOOPBACK_EVENT: &str = "auth-loopback-callback";

/// Matches the frontend's 10-minute login timeout, so an abandoned attempt
/// cannot leak a bound socket indefinitely.
const LISTENER_TTL: Duration = Duration::from_secs(600);

const RESPONSE_BODY: &str = concat!(
    "<!doctype html><meta charset=\"utf-8\"><title>Signed in</title>",
    "<body style=\"font-family:system-ui;text-align:center;padding-top:4rem\">",
    "<h1>You're signed in</h1><p>You can close this tab and return to Arcane.</p></body>"
);
```

Then add these two functions above the test module:

```rust
/// Accept until one request parses as a callback, then return it and drop the
/// listener. Requests that don't parse get a 404 and are ignored — a browser
/// prefetching `/favicon.ico` must not burn the single shot.
async fn serve_once(listener: TcpListener) -> Option<LoopbackCallback> {
    loop {
        let (mut stream, _) = listener.accept().await.ok()?;
        let mut buf = [0u8; 8192];
        let Ok(n) = stream.read(&mut buf).await else { continue };
        let text = String::from_utf8_lossy(&buf[..n]);
        let parsed = parse_request_line(text.lines().next().unwrap_or(""));

        let response = match &parsed {
            Some(_) => format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n{}",
                RESPONSE_BODY.len(),
                RESPONSE_BODY
            ),
            None => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_string(),
        };
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.shutdown().await;

        if parsed.is_some() {
            return parsed; // listener drops here — single-use
        }
    }
}

/// Bind a one-shot loopback listener and return its port. The socket is live
/// BEFORE this returns, so the port embedded in the auth URL is always real.
///
/// A cancelled attempt does not close this eagerly and does not need to: the
/// frontend has already discarded its pending attempt, so a late callback
/// fails the state check and is ignored. The TTL reaps the socket regardless.
#[tauri::command]
pub async fn auth_loopback_start(app: AppHandle) -> Result<u16, String> {
    // 127.0.0.1 explicitly — never 0.0.0.0, which would expose the callback to
    // the local network. Port 0 lets the OS pick a free ephemeral port.
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Could not bind loopback listener: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Could not read loopback port: {e}"))?
        .port();

    tauri::async_runtime::spawn(async move {
        if let Ok(Some(cb)) = tokio::time::timeout(LISTENER_TTL, serve_once(listener)).await {
            let _ = app.emit(LOOPBACK_EVENT, cb);
        }
    });

    Ok(port)
}
```

Register the command in `editor/src-tauri/src/lib.rs`, immediately after `auth::auth_deep_link_scheme,` (line 774):

```rust
            auth_loopback::auth_loopback_start,
```

- [ ] **Step 8: Run all Rust tests**

Run: `cd editor/src-tauri && cargo test`
Expected: PASS — the 10 `auth_loopback` tests plus the pre-existing 299. No warnings about unused imports.

- [ ] **Step 9: Commit**

```bash
git add editor/src-tauri/src/auth_loopback.rs editor/src-tauri/src/lib.rs
git commit -m "feat(auth): one-shot 127.0.0.1 loopback listener for browser sign-in"
```

---

### Task 2: Extract the callback-URL parser into a transport module

**Files:**
- Create: `editor/src/features/auth/services/login-transport.ts`
- Modify: `editor/src/features/auth/services/browser-login.ts`

**Interfaces:**
- Consumes: nothing (pure move).
- Produces: `parseCallback(rawUrl: string, scheme: string): ParsedCallback | null` and `redactUrlForLog(url: string): string`, both now exported from `login-transport.ts`. `browser-login.ts` re-exports `parseCallback` so existing imports and tests keep resolving.

This task is a pure move with no behavior change, kept separate so Task 3's diff shows only real logic.

- [ ] **Step 1: Create the module with the moved code**

Create `editor/src/features/auth/services/login-transport.ts`:

```typescript
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
```

- [ ] **Step 2: Remove the originals from browser-login.ts and re-export**

In `editor/src/features/auth/services/browser-login.ts`, delete the `ParsedCallback` interface, the `parseCallback` function, and the `redactUrlForLog` function. Add this import alongside the existing imports:

```typescript
import { parseCallback, redactUrlForLog, type ParsedCallback } from './login-transport';
```

And add this re-export immediately below the imports, so existing consumers and tests keep resolving:

```typescript
// Re-exported for back-compat: browser-login.test.ts and the feature barrel
// have imported these from here since Phase 3.
export { parseCallback, type ParsedCallback };
```

- [ ] **Step 3: Verify tests still pass unchanged**

Run: `cd editor && bun test src/features/auth`
Expected: PASS — the full pre-existing `browser-login.test.ts` suite, with no test edits. This is what proves the move was behavior-neutral.

- [ ] **Step 4: Typecheck**

Run: `cd editor && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add editor/src/features/auth/services/login-transport.ts editor/src/features/auth/services/browser-login.ts
git commit -m "refactor(auth): move callback-URL parsing into login-transport"
```

---

### Task 3: Both transports + platform selection

**Files:**
- Modify: `editor/src/features/auth/services/login-transport.ts`
- Test: `editor/src/features/auth/services/login-transport.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's `auth_loopback_start` command and `"auth-loopback-callback"` event; the pre-existing `auth_deep_link_scheme` command.
- Produces:
  - `type LoginTransport = (onCallback: (p: ParsedCallback) => void) => Promise<ArmedTransport>`
  - `interface ArmedTransport { params: Record<string, string>; unlisten: UnlistenFn }`
  - `deepLinkTransport: LoginTransport`, `loopbackTransport: LoginTransport`
  - `isDeepLinkSupported(): boolean`, `selectTransport(): LoginTransport`

- [ ] **Step 1: Write the failing tests**

Create `editor/src/features/auth/services/login-transport.test.ts`:

```typescript
import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Same pattern as browser-login.test.ts: register module mocks BEFORE
// dynamically importing the module under test, since Tauri APIs don't exist
// under plain `bun test` (no webview).
let invokeCalls: string[] = [];
let loopbackPort = 53411;
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) => {
    invokeCalls.push(cmd);
    if (cmd === 'auth_deep_link_scheme') return 'arcane-dev';
    if (cmd === 'auth_loopback_start') return loopbackPort;
    throw new Error(`unexpected invoke: ${cmd}`);
  },
}));

let deepLinkHandler: ((urls: string[]) => void) | null = null;
let deepLinkUnlistened = false;
mock.module('@tauri-apps/plugin-deep-link', () => ({
  onOpenUrl: async (handler: (urls: string[]) => void) => {
    deepLinkHandler = handler;
    return () => {
      deepLinkUnlistened = true;
      deepLinkHandler = null;
    };
  },
}));

let eventName: string | null = null;
let eventHandler: ((e: { payload: unknown }) => void) | null = null;
let eventUnlistened = false;
mock.module('@tauri-apps/api/event', () => ({
  listen: async (name: string, handler: (e: { payload: unknown }) => void) => {
    eventName = name;
    eventHandler = handler;
    return () => {
      eventUnlistened = true;
      eventHandler = null;
    };
  },
}));

const t = await import('./login-transport');

beforeEach(() => {
  invokeCalls = [];
  deepLinkHandler = null;
  deepLinkUnlistened = false;
  eventName = null;
  eventHandler = null;
  eventUnlistened = false;
  loopbackPort = 53411;
});

describe('deepLinkTransport', () => {
  it('sends the scheme param and delivers a matching callback', async () => {
    const seen: Array<{ code: string; state: string }> = [];
    const armed = await t.deepLinkTransport((p) => seen.push(p));

    expect(armed.params).toEqual({ scheme: 'arcane-dev' });
    expect(invokeCalls).toEqual(['auth_deep_link_scheme']);

    deepLinkHandler!(['arcane-dev://auth/callback?code=abc&state=xyz']);
    expect(seen).toEqual([{ code: 'abc', state: 'xyz' }]);
  });

  it('ignores URLs that are not callbacks', async () => {
    const seen: Array<{ code: string; state: string }> = [];
    await t.deepLinkTransport((p) => seen.push(p));

    deepLinkHandler!(['arcane-dev://something-else', 'https://example.com/x']);
    expect(seen).toEqual([]);
  });

  it('unlisten tears down the listener', async () => {
    const armed = await t.deepLinkTransport(() => {});
    armed.unlisten();
    expect(deepLinkUnlistened).toBe(true);
  });
});

describe('loopbackTransport', () => {
  it('binds a port and sends it as redirect_uri', async () => {
    loopbackPort = 61234;
    const armed = await t.loopbackTransport(() => {});

    expect(armed.params).toEqual({ redirect_uri: 'http://127.0.0.1:61234/callback' });
    expect(invokeCalls).toEqual(['auth_loopback_start']);
    expect(eventName).toBe('auth-loopback-callback');
  });

  it('delivers the callback from the Rust event', async () => {
    const seen: Array<{ code: string; state: string }> = [];
    await t.loopbackTransport((p) => seen.push(p));

    eventHandler!({ payload: { code: 'abc', state: 'xyz' } });
    expect(seen).toEqual([{ code: 'abc', state: 'xyz' }]);
  });

  it('ignores a malformed payload rather than delivering a partial callback', async () => {
    const seen: Array<{ code: string; state: string }> = [];
    await t.loopbackTransport((p) => seen.push(p));

    eventHandler!({ payload: { code: 'abc' } });
    eventHandler!({ payload: null });
    eventHandler!({ payload: 'nonsense' });
    expect(seen).toEqual([]);
  });

  it('unlisten tears down the listener', async () => {
    const armed = await t.loopbackTransport(() => {});
    armed.unlisten();
    expect(eventUnlistened).toBe(true);
  });
});

describe('selectTransport', () => {
  it('returns a callable transport', () => {
    expect(typeof t.selectTransport()).toBe('function');
  });

  it('picks loopback exactly when deep links are unsupported', () => {
    expect(t.selectTransport()).toBe(
      t.isDeepLinkSupported() ? t.deepLinkTransport : t.loopbackTransport,
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd editor && bun test src/features/auth/services/login-transport.test.ts`
Expected: FAIL — `undefined is not a function` on `t.deepLinkTransport`.

- [ ] **Step 3: Implement the transports**

Append to `editor/src/features/auth/services/login-transport.ts`:

```typescript
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
 */
export function isDeepLinkSupported(): boolean {
  const isMac = navigator.userAgent.includes('Macintosh');
  return !(isMac && import.meta.env.DEV);
}

export function selectTransport(): LoginTransport {
  return isDeepLinkSupported() ? deepLinkTransport : loopbackTransport;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd editor && bun test src/features/auth/services/login-transport.test.ts`
Expected: PASS — 9 passed.

- [ ] **Step 5: Commit**

```bash
git add editor/src/features/auth/services/login-transport.ts editor/src/features/auth/services/login-transport.test.ts
git commit -m "feat(auth): deep-link and loopback transports with platform selection"
```

---

### Task 4: Wire the transport into beginBrowserLogin

**Files:**
- Modify: `editor/src/features/auth/services/browser-login.ts`
- Modify: `editor/src/features/auth/services/browser-login.test.ts`
- Modify: `editor/src/features/auth/index.ts`

**Interfaces:**
- Consumes: Task 3's `selectTransport`, `ArmedTransport`.
- Produces: `isDeepLinkSupported` re-exported from the feature barrel (replacing `isBrowserLoginSupported`). `beginBrowserLogin`'s signature is unchanged.

- [ ] **Step 1: Write the failing test**

Add to `editor/src/features/auth/services/browser-login.test.ts`, inside the top-level describe (or at file scope alongside the existing tests):

```typescript
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd editor && bun test src/features/auth/services/browser-login.test.ts`
Expected: FAIL — `beginBrowserLogin` currently takes 2 params, so the third argument is ignored and `redirect_uri` is absent from the opened URL.

- [ ] **Step 3: Rewrite the flow to delegate**

In `editor/src/features/auth/services/browser-login.ts`:

Add to the imports:

```typescript
import { selectTransport, type ArmedTransport, type LoginTransport } from './login-transport';
```

Delete the entire `handleDeepLinkUrls` function and these three now-unused imports:

- `import { onOpenUrl } from '@tauri-apps/plugin-deep-link';` — the transport owns it
- `import { invoke } from '@tauri-apps/api/core';` — `auth_deep_link_scheme` moved to the transport
- `redactUrlForLog` from the `./login-transport` import added in Task 2 — only `handleDeepLinkUrls` used it

The `./login-transport` import narrows to exactly what the re-export still needs:

```typescript
import { parseCallback, type ParsedCallback } from './login-transport';
```

Remove the `scheme` field from `PendingAttempt` (the transport owns scheme knowledge now):

```typescript
interface PendingAttempt {
  epoch: number;
  state: string;
  verifier: string;
  /** Full `${ARCANE_WEB_URL}/auth?…` URL, kept for "Open browser again". */
  url: string;
  handlers: BrowserLoginHandlers;
  unlisten: UnlistenFn | null;
  timer: ReturnType<typeof setTimeout>;
}
```

Replace the body of `beginBrowserLogin` from the `const scheme = await invoke…` line through the final `await openUrl(url);` with:

```typescript
  // Arm the transport BEFORE opening the browser so a fast callback cannot be
  // missed. The state comparison lives HERE — one place, both transports.
  const armed: ArmedTransport = await transport(({ code, state: callbackState }) => {
    if (!pending || pending.epoch !== epoch) return;
    if (callbackState !== pending.state) {
      // Not a teardown: a mismatched callback is noise (a stale listener, a
      // replayed URL). The real one may still be coming.
      console.warn('[browser-login] callback state mismatch — ignoring');
      return;
    }
    consumeAndDeliver(code);
  });
  if (pending?.epoch !== epoch) {
    // Cancelled or superseded while arming.
    armed.unlisten();
    clearTimeout(timer);
    return;
  }
  pending.unlisten = armed.unlisten;

  const params = new URLSearchParams({ flow: 'editor', state, challenge, ...armed.params });
  const url = `${ARCANE_WEB_URL}/auth?${params.toString()}`;
  pending.url = url;

  await openUrl(url);
```

Update the signature and the placeholder `pending` assignment:

```typescript
export async function beginBrowserLogin(
  handlers: BrowserLoginHandlers,
  timeoutMs: number = LOGIN_TIMEOUT_MS,
  transport: LoginTransport = selectTransport(),
): Promise<void> {
```

```typescript
  pending = { epoch, state, verifier, url: '', handlers, unlisten: null, timer };
```

- [ ] **Step 4: Run the auth tests**

Run: `cd editor && bun test src/features/auth`
Expected: PASS — the three new tests plus every pre-existing `browser-login.test.ts` test. The deep-link tests passing untouched is the regression signal.

- [ ] **Step 5: Update the feature barrel**

In `editor/src/features/auth/index.ts`, replace the `isBrowserLoginSupported` export:

```typescript
export { default as AuthTab } from './components/AuthTab';
export { authClient, type UsageSummary } from './services/auth-client';
export {
  beginBrowserLogin,
  cancelBrowserLogin,
  submitManualCode,
  reopenBrowser,
  type BrowserLoginHandlers,
} from './services/browser-login';
export { isDeepLinkSupported } from './services/login-transport';
```

- [ ] **Step 6: Typecheck**

Run: `cd editor && bunx tsc --noEmit`
Expected: FAIL — `AuthTab.tsx` still imports `isBrowserLoginSupported`. This is expected and is fixed in Task 6; do not fix it here.

- [ ] **Step 7: Commit**

```bash
git add editor/src/features/auth/services/browser-login.ts editor/src/features/auth/services/browser-login.test.ts editor/src/features/auth/index.ts
git commit -m "feat(auth): select callback transport per platform in beginBrowserLogin"
```

---

### Task 5: Landing — redirect_uri validation and buildCallbackUrl

**Files:**
- Modify: `landing-page/src/lib/editor-login.ts`
- Modify: `landing-page/package.json`
- Create: `landing-page/vitest.config.ts`
- Test: `landing-page/src/lib/editor-login.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type EditorCallbackTarget = { kind: 'scheme'; scheme: EditorScheme } | { kind: 'loopback'; redirectUri: string }`
  - `EditorLoginRequest` now carries `target: EditorCallbackTarget` in place of `scheme`
  - `isValidLoopbackRedirect(raw: string): boolean`
  - `buildCallbackUrl(target: EditorCallbackTarget, code: string, state: string): string` (replaces `buildDeepLink`)

This is the same open-redirect-class surface that produced a CRITICAL in Phase 2b, so it gets a real harness rather than reasoning-by-inspection.

- [ ] **Step 1: Add the test harness**

Add to `landing-page/package.json` — a `test` script inside the existing `"scripts"` block:

```json
    "test": "vitest run",
```

and a new top-level `devDependencies` block:

```json
  "devDependencies": {
    "vitest": "^3.2.4"
  }
```

Create `landing-page/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

// Pure-function tests only: the modules under test must not require a DOM or
// an Astro build. Keep it that way — this harness exists for validators.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
```

Run: `cd landing-page && pnpm install`
Expected: vitest resolves and installs.

- [ ] **Step 2: Write the failing tests**

Create `landing-page/src/lib/editor-login.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
    isValidLoopbackRedirect,
    parseEditorLoginParams,
    buildCallbackUrl,
} from './editor-login';

describe('isValidLoopbackRedirect', () => {
    it('accepts the exact loopback callback shape', () => {
        expect(isValidLoopbackRedirect('http://127.0.0.1:53411/callback')).toBe(true);
        expect(isValidLoopbackRedirect('http://[::1]:53411/callback')).toBe(true);
        expect(isValidLoopbackRedirect('http://127.0.0.1:1024/callback')).toBe(true);
        expect(isValidLoopbackRedirect('http://127.0.0.1:65535/callback')).toBe(true);
    });

    it('rejects non-loopback hosts', () => {
        for (const raw of [
            'http://evil.com/callback',
            'http://localhost:53411/callback',      // DNS-resolvable, therefore rebindable
            'http://0.0.0.0:53411/callback',
            'http://127.0.0.2:53411/callback',
            'http://127.0.0.1.evil.com:53411/callback',
            'http://[::2]:53411/callback',
        ]) {
            expect(isValidLoopbackRedirect(raw), raw).toBe(false);
        }
    });

    it('rejects non-http protocols', () => {
        for (const raw of [
            'https://127.0.0.1:53411/callback',
            'file:///callback',
            'javascript:alert(1)//127.0.0.1/callback',
            'arcane://127.0.0.1:53411/callback',
        ]) {
            expect(isValidLoopbackRedirect(raw), raw).toBe(false);
        }
    });

    it('rejects wrong paths, queries and fragments', () => {
        for (const raw of [
            'http://127.0.0.1:53411/',
            'http://127.0.0.1:53411/callback-evil',
            'http://127.0.0.1:53411/callback/../evil',
            'http://127.0.0.1:53411/callback?next=x',
            'http://127.0.0.1:53411/callback#x',
        ]) {
            expect(isValidLoopbackRedirect(raw), raw).toBe(false);
        }
    });

    it('rejects embedded credentials', () => {
        expect(isValidLoopbackRedirect('http://user:pw@127.0.0.1:53411/callback')).toBe(false);
        expect(isValidLoopbackRedirect('http://evil.com@127.0.0.1:53411/callback')).toBe(false);
    });

    it('rejects missing, privileged and out-of-range ports', () => {
        for (const raw of [
            'http://127.0.0.1/callback',
            'http://127.0.0.1:80/callback',
            'http://127.0.0.1:1023/callback',
            'http://127.0.0.1:0/callback',
        ]) {
            expect(isValidLoopbackRedirect(raw), raw).toBe(false);
        }
    });

    it('rejects backslash normalization tricks and junk', () => {
        for (const raw of [
            'http:/\\127.0.0.1:53411/callback',
            'http://127.0.0.1:53411\\@evil.com/callback',
            '',
            'not a url',
        ]) {
            expect(isValidLoopbackRedirect(raw), raw).toBe(false);
        }
    });
});

describe('parseEditorLoginParams', () => {
    const CHALLENGE = 'a'.repeat(43);

    const params = (o: Record<string, string>) => new URLSearchParams(o);

    it('accepts a scheme request', () => {
        const r = parseEditorLoginParams(
            params({ state: 's', challenge: CHALLENGE, scheme: 'arcane-dev' }),
        );
        expect(r.ok && r.request.target).toEqual({ kind: 'scheme', scheme: 'arcane-dev' });
    });

    it('accepts a loopback request', () => {
        const r = parseEditorLoginParams(
            params({ state: 's', challenge: CHALLENGE, redirect_uri: 'http://127.0.0.1:53411/callback' }),
        );
        expect(r.ok && r.request.target).toEqual({
            kind: 'loopback',
            redirectUri: 'http://127.0.0.1:53411/callback',
        });
    });

    it('rejects when neither scheme nor redirect_uri is present', () => {
        const r = parseEditorLoginParams(params({ state: 's', challenge: CHALLENGE }));
        expect(r.ok).toBe(false);
    });

    it('rejects when BOTH are present', () => {
        const r = parseEditorLoginParams(
            params({
                state: 's',
                challenge: CHALLENGE,
                scheme: 'arcane-dev',
                redirect_uri: 'http://127.0.0.1:53411/callback',
            }),
        );
        expect(r.ok).toBe(false);
    });

    it('rejects a bad challenge or state regardless of target', () => {
        expect(parseEditorLoginParams(params({ state: 's', challenge: 'short', scheme: 'arcane' })).ok)
            .toBe(false);
        expect(parseEditorLoginParams(params({ state: '', challenge: CHALLENGE, scheme: 'arcane' })).ok)
            .toBe(false);
    });

    it('truncates attacker-controlled text echoed into the error', () => {
        const r = parseEditorLoginParams(
            params({ state: 's', challenge: CHALLENGE, scheme: 'x'.repeat(500) }),
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.length).toBeLessThan(400);
    });
});

describe('buildCallbackUrl', () => {
    it('builds a scheme URL', () => {
        expect(buildCallbackUrl({ kind: 'scheme', scheme: 'arcane-dev' }, 'c/1', 's 1'))
            .toBe('arcane-dev://auth/callback?code=c%2F1&state=s%201');
    });

    it('builds a loopback URL', () => {
        expect(
            buildCallbackUrl(
                { kind: 'loopback', redirectUri: 'http://127.0.0.1:53411/callback' },
                'c/1',
                's 1',
            ),
        ).toBe('http://127.0.0.1:53411/callback?code=c%2F1&state=s%201');
    });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd landing-page && pnpm test`
Expected: FAIL — `isValidLoopbackRedirect` and `buildCallbackUrl` are not exported.

- [ ] **Step 4: Implement**

In `landing-page/src/lib/editor-login.ts`:

Replace the `EditorLoginRequest` interface and add the target union:

```typescript
/** Where the website sends the browser once it holds the grant code.
 *  Exactly one form per request — the union makes "both" unrepresentable. */
export type EditorCallbackTarget =
    | { kind: 'scheme'; scheme: EditorScheme }
    | { kind: 'loopback'; redirectUri: string };

export interface EditorLoginRequest {
    state: string;      // app-generated CSRF token, echoed verbatim in the callback (1-256 chars)
    challenge: string;  // PKCE S256 challenge, base64url 43-128 chars
    target: EditorCallbackTarget;
}
```

Add the loopback validator next to `isValidChallenge`:

```typescript
// Loopback IP literals only. `localhost` is deliberately excluded: it resolves
// through DNS and is therefore rebindable, whereas an IP literal is not.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);

/** Strict shape check for the app's loopback callback. Anything that is not
 *  EXACTLY `http://127.0.0.1:<port>/callback` (or the IPv6 literal) is
 *  rejected — no query, no fragment, no credentials, no privileged port. */
export function isValidLoopbackRedirect(raw: string): boolean {
    if (typeof raw !== 'string' || raw.length === 0) return false;
    // Browsers normalize `\` to `/`, which is how `/\evil.com` becomes a
    // protocol-relative URL. Reject outright rather than enumerate bypasses.
    if (raw.includes('\\')) return false;
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return false;
    }
    if (u.protocol !== 'http:') return false;
    if (!LOOPBACK_HOSTS.has(u.hostname)) return false;
    if (u.username !== '' || u.password !== '') return false;
    if (u.pathname !== '/callback') return false;
    if (u.search !== '' || u.hash !== '') return false;
    // An absent port yields '' -> NaN -> rejected: the port must be explicit.
    const port = Number(u.port);
    return Number.isInteger(port) && port >= 1024 && port <= 65535;
}
```

Replace the body of `parseEditorLoginParams` with:

```typescript
export function parseEditorLoginParams(params: URLSearchParams): EditorLoginParseResult {
    const state = params.get('state') ?? '';
    const challenge = params.get('challenge') ?? '';
    const scheme = params.get('scheme');
    const redirectUri = params.get('redirect_uri');

    if (scheme !== null && redirectUri !== null) {
        return {
            ok: false,
            error: 'The sign-in link from the editor is malformed (it names two different ways to return). Return to Arcane and click Sign in again.',
        };
    }

    let target: EditorCallbackTarget;
    if (redirectUri !== null) {
        if (!isValidLoopbackRedirect(redirectUri)) {
            return {
                ok: false,
                error: "This sign-in link asked to return to an address this site doesn't recognize, so we stopped for your safety. Update Arcane, then click Sign in again from the editor.",
            };
        }
        target = { kind: 'loopback', redirectUri };
    } else {
        // scheme is attacker-controllable (a raw query param) and gets echoed into
        // this hard-error banner — truncate so it can't carry a paragraph of
        // spoofed content into a trusted-looking message.
        if (!isAllowedScheme(scheme ?? '')) {
            const raw = scheme ?? '';
            const shown = raw.length > 20 ? `${raw.slice(0, 20)}…` : raw;
            return {
                ok: false,
                error: `This sign-in link asked to open an app link ("${shown || 'none'}://") this site doesn't recognize, so we stopped for your safety. Update Arcane, then click Sign in again from the editor.`,
            };
        }
        target = { kind: 'scheme', scheme: scheme as EditorScheme };
    }

    if (!isValidChallenge(challenge)) {
        return { ok: false, error: 'The sign-in link from the editor is malformed (bad challenge). Return to Arcane and click Sign in again.' };
    }
    if (!isValidState(state)) {
        return { ok: false, error: 'The sign-in link from the editor is malformed (bad state). Return to Arcane and click Sign in again.' };
    }
    return { ok: true, request: { state, challenge, target } };
}
```

Replace `buildDeepLink` with:

```typescript
export function buildCallbackUrl(
    target: EditorCallbackTarget,
    code: string,
    state: string,
): string {
    const query = `code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    return target.kind === 'scheme'
        ? `${target.scheme}://auth/callback?${query}`
        : `${target.redirectUri}?${query}`;
}
```

Replace the `DEEP_LINK_RE` constant and update `loadEditorLoginRequest` / `loadEditorHandoff` to match the new shapes:

```typescript
// Derived from SCHEME_ALLOWLIST so the two can't drift apart — schemes are
// always `[a-z-]`, so no escaping is needed in the alternation.
const CALLBACK_RE = new RegExp(
    `^((${SCHEME_ALLOWLIST.join('|')})://auth/callback\\?|http://(127\\.0\\.0\\.1|\\[::1\\]):\\d{4,5}/callback\\?)`,
);
```

In `loadEditorLoginRequest`, replace the re-validation line with:

```typescript
        const t = parsed.target;
        const targetOk = t && (
            (t.kind === 'scheme' && isAllowedScheme(t.scheme)) ||
            (t.kind === 'loopback' && isValidLoopbackRedirect(t.redirectUri))
        );
        // Re-validate on load — sessionStorage is same-origin writable; never trust it blindly.
        if (!targetOk || !isValidChallenge(parsed.challenge) || !isValidState(parsed.state)) {
            sessionStorage.removeItem(REQUEST_KEY);
            return null;
        }
```

In `loadEditorHandoff`, rename the field and swap the regex:

```typescript
        if (typeof parsed.deepLink !== 'string' || typeof parsed.code !== 'string'
            || parsed.code.length === 0 || !CALLBACK_RE.test(parsed.deepLink)) {
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd landing-page && pnpm test`
Expected: PASS — 15 passed.

- [ ] **Step 6: Typecheck**

Run: `cd landing-page && pnpm exec tsc --noEmit`
Expected: FAIL — `AuthHub.tsx` still imports `buildDeepLink` and reads `pending.scheme`. Expected; fixed in Task 6.

- [ ] **Step 7: Commit**

```bash
git add landing-page/src/lib/editor-login.ts landing-page/src/lib/editor-login.test.ts landing-page/vitest.config.ts landing-page/package.json landing-page/pnpm-lock.yaml
git commit -m "feat(landing): validate loopback redirect_uri as an editor callback target"
```

---

### Task 6: Landing — wire the callback target through AuthHub

**Files:**
- Modify: `landing-page/src/components/auth/AuthHub.tsx:8-11,45-48`

**Interfaces:**
- Consumes: Task 5's `buildCallbackUrl`, `EditorCallbackTarget`.
- Produces: nothing new. `AuthSuccess.tsx` is unchanged — it reads `handoff.deepLink`, which now simply holds either URL form.

- [ ] **Step 1: Update the import**

In `landing-page/src/components/auth/AuthHub.tsx`, change the `@/lib/editor-login` import block (lines 8-11) to use the new name:

```typescript
    parseEditorLoginParams, saveEditorLoginRequest, loadEditorLoginRequest,
    clearEditorLoginRequest, saveEditorHandoff, buildCallbackUrl,
```

- [ ] **Step 2: Use the target when building the handoff**

Replace the `saveEditorHandoff` call (lines 46-49):

```typescript
                saveEditorHandoff({
                    deepLink: buildCallbackUrl(pending.target, grant.code, pending.state),
                    code: grant.code,
                });
```

- [ ] **Step 3: Typecheck**

Run: `cd landing-page && pnpm exec tsc --noEmit`
Expected: PASS — no errors. (`astro build` does not typecheck `.tsx`, so this direct `tsc` run is the only signal.)

- [ ] **Step 4: Build**

Run: `cd landing-page && pnpm build`
Expected: build succeeds.

- [ ] **Step 5: Run landing tests**

Run: `cd landing-page && pnpm test`
Expected: PASS — 15 passed.

- [ ] **Step 6: Commit**

```bash
git add landing-page/src/components/auth/AuthHub.tsx
git commit -m "feat(landing): route the editor handoff through buildCallbackUrl"
```

---

### Task 7: Un-gate the AuthTab sign-in UI

**Files:**
- Modify: `editor/src/features/auth/components/AuthTab.tsx:25-26,142,307`

**Interfaces:**
- Consumes: Task 4's barrel export.
- Produces: nothing.

Browser sign-in now works everywhere, so the predicate must stop deciding what the user can see. All three call sites become unconditional.

- [ ] **Step 1: Drop the import**

Remove `isBrowserLoginSupported` from the `../services/browser-login` import in `AuthTab.tsx`, leaving:

```typescript
import { reopenBrowser } from '../services/browser-login';
```

- [ ] **Step 2: Default to the browser flow on every platform**

Replace lines 23-27:

```typescript
  // Browser sign-in works on every platform: where the OS won't route the
  // custom scheme (macOS `tauri dev`), the loopback transport covers it.
  // Device code is a manual fallback, never a default.
  const [mode, setMode] = useState<'browser' | 'device'>('browser');
```

- [ ] **Step 3: Always offer "Switch account…"**

Replace this entire block at line 142:

```tsx
          {isBrowserLoginSupported() && (
            <button
              onClick={() => {
                void (async () => {
                  await logout();
                  startBrowserLogin();
                })();
              }}
              style={{ ...linkBtnStyle, marginTop: 12, display: 'block' }}
            >
              Switch account…
            </button>
          )}
```

with the unwrapped button:

```tsx
          <button
            onClick={() => {
              void (async () => {
                await logout();
                startBrowserLogin();
              })();
            }}
            style={{ ...linkBtnStyle, marginTop: 12, display: 'block' }}
          >
            Switch account…
          </button>
```

- [ ] **Step 4: Always offer the way back from device mode**

Replace the gate at line 307:

```typescript
          {mode === 'device' && (
```

- [ ] **Step 5: Typecheck**

Run: `cd editor && bunx tsc --noEmit`
Expected: PASS — no errors. This also clears the failure deliberately left at the end of Task 4.

- [ ] **Step 6: Run the full editor suite**

Run: `cd editor && bun test src`
Expected: PASS — 797+ tests, no regressions.

- [ ] **Step 7: Commit**

```bash
git add editor/src/features/auth/components/AuthTab.tsx
git commit -m "fix(auth): browser sign-in is reachable on every platform"
```

---

### Task 8: Title-bar Sign In button

**Files:**
- Modify: `editor/src/features/app-shell/components/TitleBar.tsx:14,48-53`
- Modify: `editor/src/App.css` (after the `.title-bar-avatar:hover` rule, ~line 252)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. Both states dispatch the existing `auth.account` command.

- [ ] **Step 1: Replace the `?` with a labelled button**

In `TitleBar.tsx`, delete line 14 (`const initial = …`) and replace the avatar button (lines 48-53) with:

```tsx
        {authLoggedIn ? (
          <button
            className="title-bar-avatar"
            title={`Signed in as ${authEmail}`}
            onClick={() => useCommandsStore.getState().executeCommand('auth.account')}
          >
            {authEmail ? authEmail.charAt(0).toUpperCase() : ''}
          </button>
        ) : (
          <button
            className="title-bar-signin"
            title="Sign in to Arcane"
            onClick={() => useCommandsStore.getState().executeCommand('auth.account')}
          >
            Sign in
          </button>
        )}
```

- [ ] **Step 2: Add the style**

In `editor/src/App.css`, immediately after the `.title-bar-avatar:hover` rule:

```css
/* Signed-out counterpart to .title-bar-avatar. A bare glyph doesn't read as
   "authenticate here", so this state is labelled. */
.title-bar-signin {
  height: 26px;
  padding: 0 10px;
  border-radius: 13px;
  background: none;
  border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  -webkit-app-region: no-drag;
  margin-left: 4px;
  flex-shrink: 0;
  white-space: nowrap;
  transition: background 150ms ease, border-color 150ms ease;
}

.title-bar-signin:hover {
  background: color-mix(in srgb, var(--accent) 15%, transparent);
  border-color: var(--accent);
}

/* In Arcane Light the titlebar is dark — match the other titlebar controls. */
:root[data-theme="arcane-light"] .title-bar-signin {
  color: var(--text-on-dark);
}
```

- [ ] **Step 3: Typecheck**

Run: `cd editor && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Verify in the running app**

Run: `cd editor && bun tauri dev`
Confirm, signed out: the title bar shows a `Sign in` pill, not a `?` circle. Click it — the Account tab opens. Sign out while signed in and confirm the control switches back from the initial avatar to the pill.

- [ ] **Step 5: Commit**

```bash
git add editor/src/features/app-shell/components/TitleBar.tsx editor/src/App.css
git commit -m "fix(ui): labelled Sign in button replaces the '?' avatar when signed out"
```

---

### Task 9: Google OAuth configuration + manual verification gate

**Files:**
- Create: `docs/superpowers/plans/2026-07-22-signin-manual-verification.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the merge gate. Do not merge to `dev` until every box is checked.

Google is configuration, not code: `auth-google.ts:81` early-returns while `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are unset. These steps are **owner-executed** — the secret values must never pass through an agent.

- [ ] **Step 1: Write the checklist**

Create `docs/superpowers/plans/2026-07-22-signin-manual-verification.md`:

```markdown
# Sign-In Manual Verification (merge gate)

Nothing here is covered by automated tests. The loopback path in particular has
never worked end-to-end, so a green unit suite is not evidence that it does.

## A. Google OAuth setup (owner)

- [ ] Google Cloud Console → APIs & Services → OAuth consent screen. User type
      External, app name "Arcane", support + developer contact email set.
- [ ] Credentials → Create Credentials → OAuth client ID → **Web application**.
- [ ] Authorized redirect URIs — all three, exactly:
      - `https://api.arcaneai.org/v1/auth/google/callback`
      - `https://api-dev.arcaneai.org/v1/auth/google/callback`
      - `http://localhost:8787/v1/auth/google/callback`
- [ ] From `arcane-server/`, set the dev secrets (paste when prompted):
      - `wrangler secret put GOOGLE_CLIENT_ID --env dev`
      - `wrangler secret put GOOGLE_CLIENT_SECRET --env dev`
- [ ] `curl -sI https://api-dev.arcaneai.org/v1/auth/google/start | grep -i location`
      → must point at `accounts.google.com`, NOT `?error=google_not_configured`.
- [ ] Sign in with Google at https://dev.arcaneai.org/auth → lands signed in.
- [ ] Sign in with Google using the SAME address as an existing email/password
      account → links rather than duplicating (`auth-google.ts` linking paths).

## B. Loopback sign-in, macOS `tauri dev` (the whole point)

- [ ] `cd editor && bun tauri dev`. Account tab shows "Continue in browser" —
      NOT "Generate Device Code".
- [ ] Click it. Browser opens `dev.arcaneai.org/auth?flow=editor&…` and the URL
      carries `redirect_uri=http://127.0.0.1:<port>/callback` (no `scheme=`).
- [ ] Complete sign-in. Browser lands on a plain "You're signed in" page and the
      editor flips to signed-in **without any manual paste**.
- [ ] Title bar shows the initial avatar; Account tab shows email, plan, credits.
- [ ] `lsof -nP -iTCP:<port>` → nothing listening. The socket is single-use.

## C. Loopback edge cases

- [ ] Start sign-in, click Cancel, start again → second attempt completes. (Two
      listeners exist briefly; the stale one is reaped by its 10-minute TTL.)
- [ ] Start sign-in, complete it, then reload the success page → editor does NOT
      sign in a second time (code is consumed).
- [ ] Start sign-in, then visit `http://127.0.0.1:<port>/callback?code=x&state=WRONG`
      by hand → editor ignores it and stays waiting; the real flow still completes.
- [ ] Start sign-in and visit `http://127.0.0.1:<port>/favicon.ico` → 404, and
      the real callback still lands afterwards.

## D. Deep link must not regress

- [ ] `cd editor && bunx tauri build --config src-tauri/tauri.dev.conf.json`,
      launch the built `Arcane Dev.app`, sign in → completes via `arcane-dev://`.
      The URL carries `scheme=arcane-dev` and NO `redirect_uri`.
- [ ] Note: `arcane-dev:` is registered to the bundle under
      `editor/src-tauri/target/release/bundle/macos/`. If that bundle is deleted
      the OS has nothing to route to — rebuild before blaming the code.

## E. Rejection paths

- [ ] Hand-open `dev.arcaneai.org/auth?flow=editor&state=s&challenge=<43 chars>&redirect_uri=http://evil.com/callback`
      → hard-error banner, no redirect.
- [ ] Same with `redirect_uri=http://localhost:53411/callback` → hard-error.
- [ ] Same with both `scheme=` and `redirect_uri=` present → hard-error.

## F. Suites

- [ ] `cd editor && bun test src` — green
- [ ] `cd editor && bunx tsc --noEmit` — clean
- [ ] `cd editor/src-tauri && cargo test` — green
- [ ] `cd landing-page && pnpm test` — green
- [ ] `cd landing-page && pnpm exec tsc --noEmit` — clean (astro build does NOT
      typecheck tsx)
- [ ] `cd landing-page && pnpm build` — succeeds
```

- [ ] **Step 2: Commit the checklist**

```bash
git add docs/superpowers/plans/2026-07-22-signin-manual-verification.md
git commit -m "docs: manual verification checklist for sign-in loopback (merge gate)"
```

- [ ] **Step 3: Execute sections A–F**

Work the checklist. Section B is the acceptance criterion for this entire plan: browser sign-in completing on macOS `tauri dev` with no manual paste. If it fails, the plan is not done — do not merge.

- [ ] **Step 4: Merge once green**

```bash
git checkout dev
git merge --no-ff fix/auth-loopback-and-signin
```
