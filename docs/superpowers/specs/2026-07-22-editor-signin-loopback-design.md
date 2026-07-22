# Editor Sign-In: Loopback Transport, Sign-In Affordance, Google Config

## Context

Phase 3 (`docs/superpowers/plans/2026-07-18-phase3-app-deeplink.md`) shipped a browser-first sign-in on the `dev` branch: PKCE, a one-time grant code, deep-link hand-back, and a manual-paste fallback. The code is sound and was reviewed. But the owner, running `bun tauri dev` on macOS, sees none of it — only a "Generate Device Code" button — and the Google button on `dev.arcaneai.org` reports that Google sign-in isn't set up.

This spec closes that gap. It is deliberately narrow: it does **not** touch billing, Turnstile, or the Phase 4 prod cutover.

## Root causes (each verified, not inferred)

1. **macOS `tauri dev` has no working browser flow.** `browser-login.ts:267` — `isBrowserLoginSupported()` returns `!(isMac && import.meta.env.DEV)`. On macOS dev it is `false`, and three call sites in `AuthTab.tsx` collapse as a result:

   - `:25-26` — `mode` defaults to `'device'` instead of `'browser'`
   - `:307` — the "Sign in with browser" escape link never renders
   - `:142` — the signed-in "Switch account…" link never renders

   So the device-code button is the only reachable sign-in control, with no way back. All three become unconditional once loopback exists.

   The underlying platform constraint is real. macOS registers custom URL schemes only through an installed `.app` bundle, and delivers them via a `kAEGetURL` Apple Event to that bundle. `tauri dev` runs the raw binary from `target/debug/`, which is not a registered bundle. Confirmed on the owner's machine: `lsregister -dump` shows `arcane-dev:` claimed by `Arcane Dev` bound to `editor/src-tauri/target/release/bundle/macos/Arcane Dev.app`. A deep link fired during `tauri dev` therefore launches that stale *release* build, not the dev process. `lib.rs:642-644` already documents that single-instance argv-forwarding is the Windows/Linux mechanism, and `register_all()` at `lib.rs:802` is `#[cfg(any(windows, target_os = "linux"))]`.

2. **Signed-out title bar shows `?`.** `TitleBar.tsx:14` — `authLoggedIn && authEmail ? authEmail.charAt(0).toUpperCase() : '?'`. Present on `dev` and `heads/v0.3.0` alike. A bare `?` in a circle reads as an error or unknown state, not as an invitation to authenticate. The tooltip says "Sign In" but tooltips are not discoverable.

3. **Google sign-in is unconfigured, not unimplemented.** `auth-google.ts:81-83` early-returns `302 → ${WEB_BASE_URL}/auth?error=google_not_configured` when `GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET` is absent; `landing-page/src/lib/auth.ts:49` maps that code to "Google sign-in isn't set up yet." The route itself is complete — PKCE, nonce, signed HS256 state cookie, JWKS verification, and the three account-linking paths including `linkGoogleSubClearingCredentials` for the unverified-row takeover case.

   Live probes on 2026-07-22:
   - `GET https://api-dev.arcaneai.org/v1/auth/google/start` → `302`, `location: https://dev.arcaneai.org/auth?error=google_not_configured`
   - `GET https://api.arcaneai.org/v1/auth/google/start` → `404` (prod still runs the pre-Phase-2a server; Phase 4 cutover never ran)

## Decisions locked with the owner

- **Loopback is added as a second transport; the deep link is kept.** Not a replacement — deep link stays primary wherever the scheme is registered. Rejected: loopback-only (discards a reviewed, verified mechanism and changes behavior for shipped v0.2.x builds) and bundling the dev binary (fragile, macOS-specific, fights the toolchain).
- **Work lands on `fix/auth-loopback-and-signin` off `dev`**, merged back to `dev` when the manual checklist passes. `heads/v0.3.0` is untouched. (`dev` is 54 commits ahead of `v0.3.0` with 0 behind, so `v0.3.0` could fast-forward, but that would pull unreleased billing into a release branch.)
- **Signed-out title bar becomes a labelled `Sign in` button**; signed-in keeps the initial avatar.
- **Google is configuration work.** The owner creates the OAuth client and runs `wrangler secret put` themselves; secret values never pass through the assistant.
- Device-code flow **stays as a last-resort fallback** but stops being any platform's default.

## Part A — Loopback transport

### Design

`beginBrowserLogin` currently hardcodes one delivery channel. The change makes the channel a choice and leaves the surrounding protocol untouched:

```
beginBrowserLogin(handlers)
  ├─ state, verifier, challenge              ← unchanged
  ├─ transport = isDeepLinkSupported()
  │     ? deepLink : loopback
  ├─ arm listener BEFORE openUrl             ← unchanged invariant
  ├─ deepLink : ?flow=editor&state&challenge&scheme=arcane-dev
  │             wait on onOpenUrl
  └─ loopback : bind 127.0.0.1:0 → port
                ?flow=editor&state&challenge&redirect_uri=http://127.0.0.1:<port>/callback
                wait on Tauri event
  → both: state match → consumeAndDeliver(code) → onCode(code, verifier)
```

Explicitly unchanged: PKCE generation, the `epoch` zombie-timer guard, the consume-before-deliver replay guard, the memory-only verifier, the 10-minute timeout, and the manual-paste fallback. Only *how the code arrives* differs. Both transports terminate in the existing `consumeAndDeliver`.

### Rust

One new command in `src-tauri/src/auth.rs`. `tokio` is already a dependency with the `net` feature — **no new crate**.

- Bind `127.0.0.1:0`; the OS assigns an ephemeral port; return it to the frontend. Binding happens *before* the browser opens, so the port in the URL is always live.
- Serve exactly one request, then shut down. Parse the request line for `code` and `state`.
- Emit a Tauri event carrying `{ code, state }`; reply `200` with a small self-contained HTML page ("You can close this tab") that echoes neither value.
- Bind `127.0.0.1` explicitly — never `0.0.0.0`.
- A cancel or the 10-minute timeout closes the listener.

The Rust side **does not validate `state`** — it only transports. The CSRF check stays in TypeScript, in exactly the place the deep-link path already does it (`handleDeepLinkUrls`: compare against `pending.state`, ignore and keep waiting on mismatch). Rust holds no copy of `state`, so there is one comparison in one place for both transports. A mismatched callback must not tear down the pending attempt — same as today.

### Website

`landing-page/src/lib/editor-login.ts` — `parseEditorLoginParams` accepts `redirect_uri` as an alternative to `scheme`. Exactly one of the two must be present. Validation is strict and origin-based, matching how `sanitizeInternalReturn` already defeats normalization tricks:

- URL parses, protocol is exactly `http:`
- hostname is exactly `127.0.0.1` or `[::1]` — *not* `localhost` (DNS-resolvable, so it is rebindable), and not any other loopback-range address
- pathname is exactly `/callback`
- port is an integer in 1024–65535
- no userinfo, no embedded credentials

Failure reuses the existing hard-error banner path, with the same truncation applied to attacker-controllable echoed text as the current bad-scheme branch.

`buildDeepLink` → `buildCallbackUrl`, returning either the scheme URL or the loopback URL. `AuthSuccess.tsx` navigates to whichever it gets; for loopback the navigation is a plain `http:` URL, so unlike a custom scheme it needs no user gesture and the "Open Arcane" button becomes a retry rather than the primary path. The `DEEP_LINK_RE` handoff validator gains the loopback form.

**No server changes.** `/v1/auth/editor/grant` and `/v1/auth/editor/exchange` are untouched; the redirect target never reaches the server.

### Two properties worth stating explicitly

- `http://127.0.0.1` is a *potentially trustworthy origin* per W3C Secure Contexts, so the HTTPS→loopback top-level navigation is not blocked as mixed content.
- RFC 8252 §7.3 recommends loopback redirection for native apps and treats custom schemes as the fallback. The local-process threat — another process on the machine racing for the callback — is covered by the existing PKCE binding plus the 60-second single-use code: an attacker who somehow received the code still lacks the memory-only verifier.

### Naming

`isBrowserLoginSupported()` becomes always-true once loopback exists, so it is renamed `isDeepLinkSupported()` for what it actually tests — and it stops gating UI. All three `AuthTab` call sites above become unconditional: `mode` defaults to `'browser'` everywhere, and both the "Sign in with browser" and "Switch account…" links always render. The device-code path survives only via the existing "Use a device code instead" link. The barrel export in `features/auth/index.ts` is updated.

The renamed predicate is still needed internally by `beginBrowserLogin` to pick a transport — it just no longer decides what the user is allowed to see.

## Part B — Title-bar sign-in affordance

`TitleBar.tsx`: signed out renders a labelled `Sign in` button; signed in keeps the circular initial avatar with the existing `Signed in as {email}` tooltip. Both dispatch the existing `auth.account` command — no store or command changes. Styling follows the existing `title-bar-btn` / `title-bar-avatar` classes; a new class covers the labelled variant.

## Part C — Google configuration (owner-executed)

Console steps, then two secrets per environment. Redirect URIs to register on the OAuth client:

```
https://api.arcaneai.org/v1/auth/google/callback
https://api-dev.arcaneai.org/v1/auth/google/callback
http://localhost:8787/v1/auth/google/callback
```

```
wrangler secret put GOOGLE_CLIENT_ID --env dev
wrangler secret put GOOGLE_CLIENT_SECRET --env dev
```

Verification: `GET /v1/auth/google/start` must `302` to `accounts.google.com`, not to `?error=google_not_configured`. Full round-trip requires a real Google account.

## Testing

- **Bun** (`browser-login.test.ts`, extending the existing `mock.module` harness): transport selection per platform/mode; loopback callback delivery; state mismatch ignored; replay after consume finds nothing; cancel closes the listener; timeout path unchanged. Deep-link tests must keep passing untouched — that is the regression signal.
- **Rust**: request-line parsing (well-formed, missing params, junk); single-use shutdown; port is non-zero and bound before return.
- **Landing**: hand-written vectors for the `redirect_uri` validator, mirroring the 28 open-redirect vectors proven in Phase 2b. Must reject `localhost`, `0.0.0.0`, non-`/callback` paths, `https:`, embedded credentials, and ports below 1024.
- **End-to-end on macOS `tauri dev` against `api-dev`** is the real gate. This has never once worked and is the entire point of the change. A green unit suite is not evidence that it does.

Note the Phase-2b gotcha: `astro build` does not typecheck `.tsx`. Run `tsc` directly.

## Out of scope

Phase 4 prod cutover; Turnstile secrets; billing; the prod `404` on `/v1/auth/google/start`. Recorded here so they are not mistaken for oversights.

## Risks

- **Stale registered bundle.** `arcane-dev:` currently resolves to a release build in `target/`. If that bundle is deleted, deep links break for the *bundled* dev app — orthogonal to this change, but it will confuse debugging. Worth noting in the manual checklist.
- **Corporate/VPN loopback interference.** Some security software intercepts loopback listeners. The manual-paste fallback remains the escape hatch, which is a reason to keep it rather than simplify it away.
- **Two transports to maintain.** Accepted deliberately: it preserves a reviewed mechanism and the shipped-build contract. The shared `onCode` terminus keeps the divergence to the delivery channel alone.
