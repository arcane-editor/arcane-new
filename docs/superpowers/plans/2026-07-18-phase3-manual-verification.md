# Phase 3 — Manual Deep-Link Verification (merge gate)

The Cursor-style browser-login loop, app side. Code complete on `dev` (editor commits `0df5881..b733bcc`). Everything below runs against the LIVE dev stack: website `dev.arcaneai.org`, API `api-dev.arcaneai.org`.

## Automated gates — PASS (2026-07-18)
- `bun test src` → 787 pass (incl. browser-login PKCE/replay/state-match suite + exchange/store state-machine tests).
- `bunx tsc --noEmit` clean; `bun run check:modules` clean.
- `cargo test --lib` → 299 pass.

## Build (`Arcane Dev.app`)
`cd editor && VITE_ARCANE_API_URL=https://api-dev.arcaneai.org VITE_ARCANE_WEB_URL=https://dev.arcaneai.org bunx tauri build --config src-tauri/tauri.dev.conf.json`
→ `src-tauri/target/release/bundle/macos/Arcane Dev.app` (+ dmg). Scheme registration verified: `CFBundleURLSchemes` = `arcane-dev` (see build-verification section once complete).

## OWNER-MANUAL checklist (GUI + OS deep-link dispatch — needs a human at the machine)

Install/launch `Arcane Dev.app` (first launch registers `arcane-dev://` with LaunchServices). Each line is the merge gate for Phase 3.

1. **Real end-to-end browser login (THE PROOF).** Account tab → "Continue in browser" → browser opens `dev.arcaneai.org/auth?flow=editor&state=…&challenge=…&scheme=arcane-dev` → sign in (email/password — Google/Turnstile pending your dashboard config) → Authorize → `arcane-dev://auth/callback` fires → app shows signed-in card. Verify: `cat ~/.arcane-dev/auth.json` (mode 0600, has token+email). AI chat streams via api-dev (`cd arcane-server && npx wrangler tail --env dev`).
2. **Wrong state ignored.** Start a login, then `open "arcane-dev://auth/callback?code=FAKE&state=BOGUS"` → app focuses, nothing happens (console: state-mismatch warn; UI still "waiting"). Real callback afterward still completes.
3. **Cancel-then-callback ignored.** Start an attempt, copy `state` from the browser URL, click Cancel, then `open "arcane-dev://auth/callback?code=FAKE&state=<copied>"` → ignored, stays 'idle' signed-out.
4. **Cold-start deep link.** Quit Arcane Dev fully → `open "arcane-dev://auth/callback?code=X&state=Y"` → app LAUNCHES, no crash, no login (memory-only verifier).
5. **Manual paste-code path.** Start attempt → complete browser login → on `/auth/success` copy the one-time code → in app expand "Paste the code" → paste → Submit → signed in (same exchange endpoint; works even if the deep link was swallowed).
6. **Timeout + retry (optional, 10 min).** Start attempt, wait out timeout → error state + working "Continue in browser" retry.
7. **macOS `tauri dev` fallback.** `bunx tauri dev` → Account tab defaults to the device-code UI (unbundled macOS can't register the scheme); device flow completes against `dev.arcaneai.org/auth/device`.
8. **Two-window sync.** Dock → New Window (two project windows), start login in A only, complete in browser → A goes waiting→signed-in; B (never had pending state) shows signed-in via the `auth-changed` reload, its AI gate clears. Sign out from B → A reflects signed-out.
9. **Windows: registry + single-instance + relaunch UX.** From the `dev-build.yml` `ArcaneDevSetup.exe`: `reg query HKCR\arcane-dev` shows the ProgID; launching the .exe a second time does NOT spawn a second process (Task Manager) — it focuses/opens a welcome window (owner-approved change); `start "" "arcane-dev://auth/callback?code=FAKE&state=BOGUS"` focuses + ignores; full browser login works via argv forwarding.

## Deferred to Phase 4 cutover / owner config
- Google login + Turnstile in the browser step (items 1 partial) — need your Google OAuth client + Turnstile widget + secrets.
- Windows checklist (item 9) — needs a Windows machine + the CI installer (which needs the CF token swap to auto-build, or a manual dev-build.yml dispatch).
