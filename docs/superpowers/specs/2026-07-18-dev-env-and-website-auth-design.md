# Dev Environment + Website-Based Auth (Cursor-style)

## Context

Arcane is moving from "base editor ready, testers using it" to monetization/production-readiness. Two blockers this plan removes:

1. **No dev environment.** Everything is hardcoded to prod: the editor bakes `https://api.arcaneai.org` into 4 source files, `arcane-server/wrangler.toml` has no `[env.*]` blocks (single D1, dashboard-mapped domain), the landing page has no committed deploy pipeline, and the only GitHub workflow (`release.yml`) builds prod installers with no env injection. The owner cannot test website→API→app end-to-end without touching prod.
2. **Auth is half-built and app-local.** The server already has email+password (PBKDF2 + HS256 JWT) and a complete device-code flow — but the website page the device flow points to (`arcaneai.org/auth/device`) was never built, there is no Google OAuth, no email verification, no password reset, and the app shows in-app credential forms. Monetization requires the Cursor/Zed model: log in on the website, hand a token to the app.

## Decisions locked with the owner

- AI features stay **sign-in-required** (already enforced via `AiSignInGate`); the rest of the editor works without an account.
- **Billing later** — no plans/credits tables now (they were deliberately dropped in migration 0008). Keep the user model lean; usage tracking already exists.
- App↔browser handoff = **deep link** (`arcane://` prod, `arcane-dev://` dev) with state + PKCE-style one-time code exchange. The existing device-code flow stays as fallback (needed for `tauri dev` on macOS + "enter code manually").
- Auth backend = **extend the existing hand-rolled Hono auth** (no Better Auth, no managed provider).
- Email sender = **Cloudflare Email Service** (Workers Email Sending binding) for verification + reset emails.
- Dev app builds are **side-by-side installable**: productName "Arcane Dev", identifier `com.inno.editor.dev`, config dir `~/.arcane-dev`, scheme `arcane-dev://`.
- Dev URLs: website `https://dev.arcaneai.org` (second Pages project), API `https://api-dev.arcaneai.org` (`[env.dev]` worker `arcane-server-dev`, own D1 `arcane-db-dev`, shared Vectorize index, own AI Gateway `arcane-ai-gateway-dev`).
- URL selection: local `tauri dev` + dev builds → dev API; prod builds → prod API. Via a single new config module + `VITE_` vars; `.env.local` can override to `http://localhost:8787` for `wrangler dev`.

## Current-state facts the plan builds on (verified by exploration)

- Editor hardcodes prod URL in: `editor/src/features/auth/services/auth-client.ts:4`, `editor/src/features/ai-panel/services/arcane-stream.ts:32`, `editor/src/features/ai-panel/services/unity-tools/api-client.ts:19`, `editor/src/features/graphify/services/graphify-enrich.ts:17`. All three API clients read `useAuthStore.getState().token` → single choke point.
- Token stored at `~/.arcane/auth.json` (0600) via Rust commands in `editor/src-tauri/src/auth.rs`; store `editor/src/stores/auth.ts`; UI `editor/src/features/auth/components/AuthTab.tsx`.
- Tauri: no `plugins` section, no deep-link/single-instance plugins; opener plugin present (`openUrl`); hand-rolled multi-instance note at `src-tauri/src/lib.rs:~790` (needs reconciliation).
- Server: Hono, routes in `arcane-server/src/routes/` (`auth.ts` has signup/login/me/device flow; `verification_uri` hardcoded to `https://arcaneai.org/auth/device` at auth.ts:~134). `users(email, password_hash, salt, role, created_at)`; migrations through 0011; `authMiddleware` in `src/middleware/auth.ts`; permissive CORS; deploy is manual `wrangler deploy`; only secret `JWT_SECRET`.
- Landing page: static Astro 5 + Starlight (NO adapter — stays SSG; auth pages are client React islands). Existing API client `landing-page/src/lib/auth.ts` reads `PUBLIC_API_URL` (defaults prod), token in localStorage; working admin login. Pages project `arcane-landing` (direct-upload, `--branch main` required).
- CI: only `.github/workflows/release.yml` (v* tags; secrets `CLOUDFLARE_API_TOKEN` [R2-scoped — needs perms expansion for Workers/Pages/D1] + `CLOUDFLARE_ACCOUNT_ID`; gotchas: `CI= bun run build:lsp-sidecars`, use `bunx tauri build` not `bun run tauri`).

---

## Part A — Dev environment + CI/CD

### Verified facts shaping this part
- Wrangler named envs do NOT inherit bindings/vars (each env needs the full set), but `routes` IS inheritable → `[env.dev]` must override routes or a dev deploy would claim `api.arcaneai.org`.
- Tauri v2 `--config` = RFC 7396 JSON Merge Patch; arrays replaced wholesale (clean scheme swap).
- Vite precedence: `.env.[mode]` outranks `.env.local`; shell env outranks everything → local overrides go in `.env.development.local`; CI dev build just exports `VITE_*` in step env.
- `~/.arcane` used in 3 places: `src-tauri/src/auth.rs:16`, `src-tauri/src/graphify.rs:40`, `src/features/ai-panel/services/session-persistence.ts:71-72`.
- Root `.gitignore` ignores `.env.*` → need `!.env.development` / `!.env.production` negations (public URLs only; secret-bearing `editor/.env` stays ignored).
- `PUBLIC_API_URL` read in `landing-page/src/lib/auth.ts:1` AND `landing-page/src/components/FeedbackSection.astro:2` (build-time env only, no code change).

### A1. arcane-server wrangler.toml
Add prod `routes = [{ pattern = "api.arcaneai.org", custom_domain = true }]` (adopting the dashboard mapping — first deploy with it done MANUALLY, not CI) + `WEB_BASE_URL = "https://arcaneai.org"` var (seam for Part B; also add to `AppEnv.Bindings` in `src/types.ts`). Then full `[env.dev]` block: name `arcane-server-dev`, routes `api-dev.arcaneai.org` (custom_domain auto-creates DNS), own D1 (`arcane-db-dev`, same binding name `arcane_db`), same `[ai]` binding, SAME Vectorize `unity-docs-v1` (shared read-only corpus), vars `ENVIRONMENT=development`, `CF_AI_GATEWAY_ID=arcane-ai-gateway-dev`, `WEB_BASE_URL=https://dev.arcaneai.org`, observability on. Dev `JWT_SECRET` set separately with a DIFFERENT value (tokens must not cross envs). package.json: add `deploy:dev`, `db:migrate:dev:remote` scripts.

### A2. Editor API config module + env files
- **New** `editor/src/config/api.ts`: `ARCANE_API_URL` / `ARCANE_WEB_URL` from `import.meta.env.VITE_ARCANE_*` with PROD fallbacks (fail-safe).
- **New committed** `editor/.env.development` (dev URLs — `tauri dev` picks these up automatically via vite mode) and `editor/.env.production` (prod URLs). No `--mode` flags or vite.config changes needed. Local worker override documented: `.env.development.local` → `http://localhost:8787`.
- Root `.gitignore` negations; augment `editor/src/vite-env.d.ts` ImportMetaEnv.
- Replace the 4 hardcoded constants with imports; run `bun run check:modules`.

### A3. Side-by-side dev app
- **New** `editor/src-tauri/tauri.dev.conf.json` overlay: `productName "Arcane Dev"`, `identifier com.inno.editor.dev`, `plugins.deep-link.desktop.schemes: ["arcane-dev"]` (inert until Part C lands the plugin). Build: `bunx tauri build --config src-tauri/tauri.dev.conf.json`. Identifier change auto-isolates Tauri appData paths; existing workflow globs still match bundle names.
- Config-dir isolation keyed off identifier (single source of truth, no env plumbing): `auth.rs` `auth_file_path()` takes `AppHandle`, uses `.arcane-dev` when identifier ends with `.dev`; extract shared `arcane_home_dir(app)` helper and reuse in `graphify.rs:40`; new `get_arcane_home_dir` command consumed by `session-persistence.ts:71-72` (replaces `join(homeDir(), '.arcane', ...)`).

### A4. GitHub Actions (3 NEW workflows; release.yml untouched)
**Prerequisite (loud):** replace the R2-scoped `CLOUDFLARE_API_TOKEN` secret with one adding Workers Scripts:Edit, Pages:Edit, D1:Edit (account) + Workers Routes:Edit, DNS:Edit (zone arcaneai.org), keeping R2:Edit.
1. `dev-build.yml`: push to `dev` branch (paths `editor/**`) + dispatch. Same matrix/setup/gotchas as release.yml (`setup-node 22` pin, `CI= bun run build:lsp-sidecars`, `bunx tauri` not `bun run tauri`). Build step env adds `VITE_ARCANE_API_URL/VITE_ARCANE_WEB_URL` (dev) and `--config src-tauri/tauri.dev.conf.json`. Assets `Arcane-Dev-arm64.dmg` / `ArcaneDevSetup.exe` → R2 `arcane-releases/dev/latest/` (+ optional `dev/<short-sha>/`).
2. `deploy-server.yml`: push to `dev` (paths `arcane-server/**`) → migrations (`d1 migrations apply arcane-db-dev --env dev --remote`) BEFORE `wrangler deploy --env dev`; prod job only via dispatch `environment=production` (migrations + deploy).
3. `deploy-landing.yml`: push to `dev` (paths `landing-page/**`) → pnpm 9 pin (lockfile 9.0), `pnpm install && pnpm build` in `landing-page/` (load-bearing `.npmrc` picked up) with `PUBLIC_API_URL=https://api-dev.arcaneai.org` (+ future Part B `PUBLIC_*` vars) → `wrangler pages deploy dist --project-name arcane-landing-dev --branch main`; prod job via dispatch → project `arcane-landing --branch main`.

### A5. Branch setup
Create long-lived `dev` branch from `master`; all work lands on `dev` first. Merging to master later changes nothing prod-visible (prod URLs are build defaults; routes adoption handled manually).

### A6. One-time Cloudflare runbook
1. `wrangler d1 create arcane-db-dev` → paste id → `d1 migrations apply ... --remote` (0002_seed runs automatically). 2. Create AI Gateway `arcane-ai-gateway-dev` (dashboard). 3. `wrangler secret put JWT_SECRET --env dev` (fresh value); `wrangler secret list` on prod to enumerate others; Part B adds Google/email secrets. 4. First `wrangler deploy --env dev` (creates worker + attaches api-dev domain + DNS). 5. Manual prod deploy adopting routes; verify `/health`. 6. `wrangler pages project create arcane-landing-dev --production-branch main`; manual first deploy; dashboard: attach `dev.arcaneai.org`. 7. Replace GitHub `CLOUDFLARE_API_TOKEN` secret.

### A7. Verification
Dry-run deploys both envs (names/routes/bindings); `curl` both `/health`; D1 dev table list; dev unity-api search returns results (proves shared Vectorize); chat via dev shows in dev gateway only; dev.arcaneai.org network tab hits api-dev; `tauri dev` hits api-dev, `.env.development.local` override hits localhost; Arcane Dev installs ALONGSIDE prod, token lands in `~/.arcane-dev/auth.json`, chat streams via api-dev (`wrangler tail --env dev`); prod regression: release.yml green, prod bundle greps `api.arcaneai.org`, prod site unchanged.

---

## Part B — Auth backend (server) + website auth pages

### Design decisions
- **One new `auth_tokens` table** for all one-time secrets (`purpose`: `verify_email` | `password_reset` | `web_login` | `editor_login`; raw token never stored — SHA-256 hex at rest; TTL; single-use via atomic `UPDATE … SET consumed_at … WHERE consumed_at IS NULL AND expires_at > now RETURNING *`). `device_codes` untouched (live deployed state machine stays as fallback).
- `password_hash` stays NOT NULL; OAuth-only users get `''` sentinel (D1 can't drop NOT NULL without table rebuild). Code explicitly treats `''` as "no password set".
- **Google callback host = API domain** (`/v1/auth/google/callback`); a signed (JWT_SECRET-HMAC) HttpOnly SameSite=Lax cookie (10-min, Path=/v1/auth/google) carries `{state, nonce, pkce_verifier, return_to}` across the round trip. ID token verified via jose remote JWKS + iss/aud/exp/nonce + Google `email_verified === true` required.
- **Post-Google handoff to the static site = 60s single-use code in query string** (never a JWT in URL/fragment), exchanged via `POST /v1/auth/web/exchange`.
- **Editor context (`state`/`challenge`/`scheme`) lives in website sessionStorage** across the Google redirect; server OAuth state handles only CSRF+return_to. One island handles the editor grant for both login methods. `state` is server-invisible: app-generated, echoed in the deep link, app-verified.
- **`token_version` check in `authMiddleware`**: one PK-indexed D1 read per request (negligible vs LLM latency; also yields fresh `role`/`email_verified`, catches deleted users). Legacy tokens without the claim = version 0 → existing users' 30-day tokens keep working.
- **`email_verified` enforced per-route** via new `requireVerifiedEmail()` on `/v1/chat/*`, `/v1/embeddings`, `/v1/graph/*`, `/v1/unity/*` (403 `email_unverified`); NOT in authMiddleware (unverified users must reach `/me`, resend, account routes). Google users auto-verified; migration grandfathers ALL existing users to verified.
- **Rate limiting = Cloudflare ratelimit bindings** (`[[unsafe.bindings]]`): `RL_AUTH_STRICT` 10/60s/IP on credential endpoints, `RL_AUTH_POLL` 60/60s/IP on device polling. No D1 counters.
- **Turnstile INCLUDED now** (owner decision): widget on signup/login/forgot forms; server-side siteverify on those endpoints; implement with the `cloudflare:turnstile-spin` skill. Secrets: `TURNSTILE_SECRET` (worker), `PUBLIC_TURNSTILE_SITE_KEY` (Pages build env — add to deploy-landing.yml in Part A4.3).
- Enumeration trade-offs (accepted): signup on Google-only account → 409 `google_account`; login on Google-only → 401 `use_google`; `/forgot` always-200.
- Discrepancy found: editor's `X-Refreshed-Token` client handling is dead code — the server never sends that header. Leave/remove as minor cleanup in Part C; plan assumes no sliding refresh.

### B1. Server steps (arcane-server/)
1. **Migration `migrations/0012_auth_accounts.sql`**: `users` + `google_sub` (partial unique index), `email_verified` (then `UPDATE users SET email_verified = 1` grandfather), `token_version`; create `auth_tokens` (+ indexes on `(user_id, purpose, created_at)` and `expires_at`).
2. **New `src/lib/tokens.ts`**: `generateToken` (32B base64url), `sha256Hex`, `s256Challenge`; TTL constants (verify 24h, reset 30min, web_login 60s, editor_login 60s).
3. **`src/lib/db.ts`**: extend `UserRow`; `findUserByGoogleSub`, `linkGoogleSub` (sets verified), `createOAuthUser` (`password_hash=''`, verified), `setEmailVerified`, `updatePasswordBumpVersion`, `bumpTokenVersion`; `createAuthToken`, atomic `consumeAuthToken`, `countRecentAuthTokens` (resend throttle 3/hr), `cleanExpiredAuthTokens` (opportunistic, mirrors `cleanExpiredDeviceCodes`).
4. **`src/middleware/auth.ts`**: payload gains `email_verified`/`token_version`; post-verify D1 read (`SELECT id, role, email_verified, token_version`) → 401 if user gone or version mismatch (`payload.token_version ?? 0`); export `requireVerifiedEmail()` and shared `makeJwtPayloadFromUser()` so all JWT mint points emit identical claims.
5. **New `src/middleware/rate-limit.ts`**: `rateLimit('RL_AUTH_STRICT'|'RL_AUTH_POLL')`, key = `CF-Connecting-IP`, 429 on limit.
6. **New `src/lib/email.ts`** (load `cloudflare:cloudflare-email-service` skill first): `sendVerificationEmail` → `${WEB_BASE_URL}/verify?token=…`, `sendPasswordResetEmail` → `${WEB_BASE_URL}/reset?token=…`; via `EMAIL` send_email binding inside `waitUntil`; plain+HTML MIME from `EMAIL_FROM`. Extend `src/lib/log.ts` with `logAuthEvent` (structured JSON; never log tokens/passwords).
7. **New `src/routes/auth-email.ts`**: `POST /v1/auth/verify {token}` → fresh JWT; `resend-verification` (Bearer, throttled); `forgot {email}` (always-200); `reset {token,newPassword}` → bumps token_version (kills all sessions) + sets verified + fresh JWT; `change-password` (Bearer; 400 `no_password_set` for Google-only).
8. **New `src/routes/auth-google.ts`**: `GET /v1/auth/google/start?return_to=…` (allowlisted path, cookie, 302 to Google w/ PKCE S256 + nonce + `prompt=select_account`); `GET /v1/auth/google/callback` (state check → token exchange → ID-token verify → login by `google_sub` / **link by email** / create → 60s `web_login` code → 302 `${WEB_BASE_URL}${return_to}?code=…`; failures → 302 `/auth?error=google_oauth_failed`); `POST /v1/auth/web/exchange {code}` → `{token, user}`.
9. **New `src/routes/auth-editor.ts`**: `POST /v1/auth/editor/grant` (Bearer, `{challenge}` base64url 43–128) → `{code, expires_in: 60}`; `POST /v1/auth/editor/exchange {code, verifier}` (public) → atomic consume + `s256Challenge(verifier) === challenge` → full 30-day JWT; single opaque `invalid_code` error for all failure modes.
10. **`src/routes/auth.ts`**: signup validation (email format, min-8 password) + Turnstile verify + Google-only 409 + verification email; login Turnstile verify + Google-only 401 `use_google`; `/me` gains `emailVerified`/`hasPassword`/`googleLinked`; `device/code` `verification_uri` from `WEB_BASE_URL` (kills hardcoded URL at auth.ts:134).
11. **`index.ts`**: CORS allowlist `[arcaneai.org, www, dev.arcaneai.org, localhost:4321, localhost:1420, tauri://localhost, http(s)://tauri.localhost]` + `allowHeaders [Authorization, Content-Type]` (no-Origin requests — editor native fetch, Google redirects — unaffected); mount 3 new routers; apply rate limiters; `requireVerifiedEmail()` on AI routes.
12. **`src/routes/admin.ts`**: admin-created users verified; admin password set uses `updatePasswordBumpVersion`.
13. **`wrangler.toml` + `src/types.ts`**: vars `WEB_BASE_URL`/`API_BASE_URL`/`EMAIL_FROM`; bindings `EMAIL` (send_email), `RL_AUTH_STRICT`/`RL_AUTH_POLL` (ratelimit, namespace_ids 1001/1002); secrets `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`TURNSTILE_SECRET` — all mirrored in `[env.dev]` (dev WEB/API base URLs; same binding names → code unchanged).

### B2. Website steps (landing-page/, stays static SSG)
1. **`src/lib/auth.ts`**: `AuthUser.emailVerified`; add `googleStartUrl`, `apiWebExchange`, `apiEditorGrant`, `apiVerifyEmail`, `apiResendVerification`, `apiForgot`, `apiReset`, `apiChangePassword`.
2. **New `src/lib/editor-login.ts`**: `SCHEME_ALLOWLIST = ['arcane','arcane-dev']`; sessionStorage save/load/clear for `{state, challenge, scheme}` + `{deepLink, code}` handoff; input validation.
3. **`/auth` hub** (`pages/auth/index.astro` + `components/auth/AuthHub.tsx`, client:load in LandingLayout): on mount — capture `?flow=editor&state&challenge&scheme` (allowlist check; strip via replaceState) → handle `?code=` Google return via `apiWebExchange` → if logged in + pending editor request → `apiEditorGrant` → build `${scheme}://auth/callback?code&state` → `/auth/success`; else sign-in/sign-up tabs (with Turnstile widget) + "Continue with Google". Editor grant works while unverified (only AI endpoints gated).
4. **`/auth/success`** (+`AuthSuccess.tsx`): auto-attempt deep link + "Open Arcane" button (gesture fallback) + copyable one-time code ("didn't open?") — the Part C manual-paste counterpart; clears sessionStorage after render.
5. **`/auth/device`** (+`DeviceAuthorize.tsx`): the missing device-flow page; login round-trip preserves `?user_code=`; `apiAuthorizeDevice` → "Return to the editor".
6. **`/verify`, `/forgot`, `/reset`** (+islands): verify swaps stored token for the returned fresh JWT and resumes pending editor flow via `/auth`; forgot always-success message; reset stores new token, notes other sessions signed out.
7. **`/account`** (+`AccountPanel.tsx`): email, verified badge + resend, Google link status, change/set password, sign out.
8. **`Navbar.tsx`**: "Sign in"/"Account" link from `getStoredToken()`.

### B3. Security properties (summary)
Google: cookie-signed state (CSRF) + PKCE S256 + nonce + return_to allowlist. Handoff codes: 32B random, hashed at rest, 60s TTL, atomic single-use, stripped from URL. Editor link: PKCE verifier never leaves app, app-verified state, scheme allowlist, opaque errors, rate-limited exchange. Email tokens: hashed, 24h/30min TTLs, single-use; reset revokes all sessions via token_version. Legacy tokens grandfathered (version 0).

### B4. One-time runbook (Part B additions)
1. Google Cloud: OAuth consent screen (External, published) + Web client; redirect URIs `https://api.arcaneai.org/v1/auth/google/callback`, `https://api-dev.arcaneai.org/...`, `http://localhost:8787/...`; `wrangler secret put GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET` (prod + `--env dev`).
2. Email Service (via skill): onboard `arcaneai.org` sending domain (SPF/DKIM/DMARC in the CF zone), `no-reply@arcaneai.org`, test send.
3. Turnstile: create widget (hostnames arcaneai.org, dev.arcaneai.org, localhost) → `TURNSTILE_SECRET` secrets + `PUBLIC_TURNSTILE_SITE_KEY` in both landing deploy jobs.
4. Migration 0012: local → dev remote → prod remote. Deploy order: server before website (same day — the `verification_uri` change needs `/auth/device` live).

---

## Part C — App-side deep-link auth (editor/)

### C1. Rust plumbing
- `src-tauri/Cargo.toml`: add `tauri-plugin-deep-link = "2"` and `tauri-plugin-single-instance = { version = "2", features = ["deep-link"] }` (plain `[dependencies]`, `#[cfg(desktop)]` in code). The `deep-link` feature auto-forwards `arcane://` URLs from a second instance's argv to the deep-link plugin (Windows/Linux path).
- `src-tauri/tauri.conf.json`: add top-level `plugins.deep-link.desktop.schemes: ["arcane"]`. macOS Info.plist (`CFBundleURLTypes`) written by bundler; Windows NSIS writes `HKCR\arcane` at install. **Dev overlay must override both `identifier` and `schemes: ["arcane-dev"]`** (JSON merge replaces arrays — clean).
- `src-tauri/capabilities/default.json`: add `"deep-link:default"` (verify `allow-get-current` is included after first build; add explicitly if not).
- `src-tauri/src/lib.rs`:
  - Register single-instance **first** in the builder chain (line ~637). Callback: if argv has no URL (plain re-launch), call `open_or_focus_welcome(app)` — this preserves the deliberate Windows "launch again = new window" UX documented at lib.rs:788-792 (comment must be updated). Un-gate `open_or_focus_welcome` (currently `#[cfg(target_os = "macos")]` at line 595).
  - Then `.plugin(tauri_plugin_deep_link::init())`.
  - In `setup`: `#[cfg(any(windows, target_os = "linux"))] app.deep_link().register_all()` (runtime registration for dev/portable; macOS cannot register at runtime → device-flow fallback for `tauri dev` on mac).
- `src-tauri/src/auth.rs`: new command `auth_deep_link_scheme(app)` reading the merged tauri config's `plugins.deep-link.desktop.schemes[0]` (single source of truth — dev overlay automatically honored). Register in `generate_handler` (~line 753). The `~/.arcane` → `~/.arcane-dev` split lands in `auth_file_path()` here, keyed off `app.config().identifier` (coordinate with Part A overlay).
- `bun add @tauri-apps/plugin-deep-link`.

### C2. Frontend service + store
- **New** `editor/src/features/auth/services/browser-login.ts`: pure helpers `generateState/generateVerifier/challengeS256/parseCallback` (WebCrypto, base64url, unit-testable) + `beginBrowserLogin/cancelBrowserLogin/submitManualCode/reopenBrowser/isBrowserLoginSupported`. Flow: teardown any pending attempt → generate state+PKCE verifier/challenge → get scheme via `invoke('auth_deep_link_scheme')` → register `onOpenUrl` listener BEFORE `openUrl(`${ARCANE_WEB_URL}/auth?flow=editor&state&challenge&scheme`)` (the `flow=editor` param is what Part B's AuthHub keys on) → 10-min timeout. Callback validation: strict `scheme://auth/callback` parse, state must match pending (else warn+ignore), consume verifier (`pending = null`) before exchange to block replays. Listener exists only while an attempt is pending (stale cold-start URLs replayed by `getCurrent()` fail the state check by design). Multi-window: deep-link event broadcasts to all webviews; only the initiating window holds matching state — no routing logic needed. Verifier is memory-only (never persisted; cold-start deep link intentionally can't complete a login).
- `editor/src/features/auth/services/auth-client.ts`: add `exchangeEditorCode(code, verifier)` → `POST /v1/auth/editor/exchange` → existing `saveToken()`. Delete `login()`/`signup()`. Replace `DEFAULT_SERVER_URL` with config-module import. Keep device-flow methods + `loadFromDisk` + `logout` (add fire-and-forget server revoke if Part B lands one).
- `editor/src/stores/auth.ts`: replace `loading` with `loginStatus: 'idle'|'waiting-browser'|'exchanging'|'error'`; actions `beginBrowserLogin/cancelBrowserLogin/submitManualCode`; remove `login`/`signup` (AuthTab was the only consumer — verified). Extend `loadFromDisk` to reset state when the token file is missing.
- `editor/src/features/auth/index.ts`: export new service surface through the barrel.
- Manual-code fallback = **same one-time code + exchange endpoint** (not device flow): `/auth/success` shows the code; app already holds the verifier, so PKCE binding is preserved. Only shown while an attempt is pending.

### C3. UI + cross-window sync
- `AuthTab.tsx` rework: signed-in card (email/plan/Sign Out/Switch account); idle → primary "Continue in browser" + "Use a device code instead" link (existing device-flow UI kept; becomes the DEFAULT when `isBrowserLoginSupported()===false`, i.e. macOS `tauri dev`); waiting → spinner + "Open browser again" (same state) + Cancel + collapsible paste-code input; delete email/password/promo forms.
- Cross-window sync: `emit('auth-changed')` after login/logout; `App.tsx` mount effect listens and calls `loadFromDisk()` (closes pre-existing "window B stale after login in window A" gap).

### C4. Tests
- **New** `browser-login.test.ts` (bun:test, mock Tauri APIs like `arcane-stream.test.ts`): verifier charset/length, S256 known vector, parseCallback matrix (wrong scheme/host/missing params), state-mismatch ignored, consumed-verifier replay guard.

### C5. Edge cases (decided)
Cold start via deep link → can't complete login by design (memory-only verifier); replay/expired → server rejects, error state; re-login while pending → teardown+restart; signed-in re-login → account switch, token overwrite; 401 during AI stream → unchanged (`arcane-stream.ts` clears auth, gate shows browser button).

### C6. Resolved decisions
- **Windows single-instance change: APPROVED by owner.** Today N launches = N processes (deliberate, lib.rs:788-792 — comment must be updated); after: one process, re-launch opens welcome window in it (VS Code/Cursor pattern, required for deep links). Visible UX preserved via the single-instance callback.
- Server contract now DEFINED by Part B step B1.9: `POST /v1/auth/editor/exchange {code, verifier}` → `{token, user}`; `/auth/success` shows the same one-time code for manual paste. ✓ Consistent.
- Optional cleanup while in `auth-client.ts`: remove the dead `X-Refreshed-Token` handling (server never sends it).

---

## Execution order

Work happens on a new long-lived `dev` branch (Part A5). Each phase is independently verifiable before the next:

1. **Phase 1 — Part A** (dev infra + CI): runbook A6 first (D1, gateway, Pages project, token), then wrangler env, editor config module, overlay, 3 workflows. Gate: A7 checklist green.
2. **Phase 2 — Part B** (server + website), deployed to DEV only: migration 0012 on dev D1, server `--env dev`, website to `arcane-landing-dev`. Gate: full browser-only auth verification on dev.arcaneai.org (signup/verify/reset/Google/link/device page) — no app involvement yet.
3. **Phase 3 — Part C** (app): against dev API/website. `tauri dev` on mac exercises the device-flow fallback; a bundled Arcane Dev build (dev-build.yml) exercises the real `arcane-dev://` deep link on both OSes.
4. **Phase 4 — Prod cutover**: prod migration 0012 + manual prod `wrangler deploy` (adopts routes block), prod landing deploy, then a `v*` tag for the prod app release. Google/Turnstile/Email prod hostnames were configured in the runbooks, so cutover is deploy-only.

Implementation-time skills to load: `cloudflare:cloudflare-email-service` (B1.6), `cloudflare:turnstile-spin` (B forms), `cloudflare:wrangler` / `cloudflare:workers-best-practices` (Part A/B worker changes), `superpowers:test-driven-development` where tests apply (browser-login helpers, server token/consume logic).

## End-to-end verification (the proof the owner asked for)

The full-stack dev-environment test after all phases: install **Arcane Dev** beside prod Arcane → click Sign in → browser opens `dev.arcaneai.org/auth?flow=editor…` → create account with email (Turnstile passes, verification email arrives from no-reply@arcaneai.org) / or Continue with Google → Authorize → `arcane-dev://` deep link fires → app signed in, token in `~/.arcane-dev/auth.json` → AI chat streams through `api-dev.arcaneai.org` (visible in `wrangler tail --env dev` + dev AI Gateway logs; blocked with 403 until email verified) → prod app, prod site, prod API meanwhile untouched (release.yml still green, `api.arcaneai.org/health` 200, prod gateway silent). Detailed per-case checklists: A7, B4/agent checklist, C verification list.

## Open items / prerequisites on the owner

- Google Cloud account access to create the OAuth consent screen + client (runbook B4.1).
- Cloudflare dashboard steps that need a human: AI Gateway creation, Pages custom-domain attach, Email Service domain onboarding, Turnstile widget, replacement API token → GitHub secret.
- Existing testers keep working: their tokens stay valid (version-0 grandfathering) and their accounts are pre-verified by migration 0012.
