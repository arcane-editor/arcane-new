# Phase 2b — Manual Verification Checklist (merge/cutover gate)

Deployed to **https://dev.arcaneai.org** (Pages project `arcane-landing-dev`) against the live dev API `https://api-dev.arcaneai.org`. Landing-page commits `0301657..<T7>` on `dev`.

## Automated / scriptable checks — PASS (done 2026-07-18)

- All 7 pages serve 200: `/auth`, `/auth/success`, `/auth/device`, `/verify`, `/forgot`, `/reset`, `/account`.
- Built bundle bakes `api-dev.arcaneai.org`; **zero** `https://api.arcaneai.org` (prod) leakage.
- Turnstile script absent when `PUBLIC_TURNSTILE_SITE_KEY` unset (graceful degradation).
- `google_not_configured` friendly-message mapping present in bundle; `arcane`/`arcane-dev` scheme allowlist present.
- Editor exchange endpoint live + opaque: `POST /v1/auth/editor/exchange` bad code → `{"error":"invalid_code"}`.
- Device `verification_uri` = `https://dev.arcaneai.org/auth/device`.
- Prod untouched: `arcaneai.org/auth` → 404 (no auth pages until Phase 4); `api.arcaneai.org/health` → 200.
- Open-redirect guard (`sanitizeInternalReturn`) proven against 28 vectors incl. backslash/unicode/userinfo/traversal (P2b-2 fix review).

## OWNER-MANUAL browser checks (need a human at a browser / a real inbox / owner config)

Work through on https://dev.arcaneai.org; every non-deferred line must pass before Phase 4 prod cutover.

**Email/password (live today):**
1. Create account (fresh email, 8+ char pw) → `/account`, "Unverified" badge.
2. Wrong password → "Incorrect email or password."
3. Bad email → invalid-email msg; 5-char pw → weak-password msg.
4. Duplicate email → server error surfaced (note the code if unlisted).
5. Sign out → Navbar flips to "Sign in"; `/account` bounces to `/auth`, returns after sign-in.

**Editor round-trip (mocked scheme, no app):**
6. Signed in → `/auth?flow=editor&state=teststate-123&challenge=aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789-_aBcDe&scheme=arcane` → `/auth/success` → code visible + Copy works → refresh → "Nothing to hand off".
7. Same signed OUT → "editor is asking to sign in" → sign in → grant proceeds → `/auth/success`.
8. `scheme=arcane-dev` → deep link is `arcane-dev://auth/callback?...`.
9. `scheme=evil` / `challenge=short` → hard error, NO deep link, nothing saved.

**Device flow (live today):**
11. `POST /v1/auth/device/code` → open `verification_uri?user_code=<CODE>` signed out → sign-in round trip preserves code → Authorize → "Device authorized"; re-authorize same code → error (single-use).

**Email-token pages — DEFERRED (need a real inbox; raw token unrecoverable from hashed DB):**
12. Signup → verification email from no-reply@arcaneai.org → `/verify?token=…` → "Verified"; `/account` badge → "Verified". (`/account` "Resend email" → `{ok:true}` toast is testable today.)
13. Mid-editor-flow verify resume in same tab.
14. `/forgot` known+unknown → identical copy; reset email → `/reset?token=…` → new pw → other sessions 401. **Garbage tokens on `/verify` + `/reset` → friendly errors: testable TODAY.**

**Graceful degradation — DEFERRED until owner config:**
15. Turnstile: unset var → no widget, signup/login still work. After owner sets var + `TURNSTILE_SECRET`: widget on `/auth` tabs.
16. Google: "Continue with Google" → "Google sign-in isn't set up yet" banner. After owner does B4.1: full loop (Google → consent → `?code=` → exchange → `/account`); Google-only `/account` shows Connected + "Email me a set-password link".
17. `/auth?code=garbage` → invalid-code banner; `/auth?return=//evil.com` after sign-in → `/account`, never off-site. (Redirect guard already proven scriptably.)

**Account/session:**
18. Change pw wrong current → mapped error; correct → toast, this browser stays in (fresh JWT), a second browser bounces on next action (token_version bump).
19. 4th resend within an hour → `resend_throttled` message.

## Deferred items carried to Phase 4 cutover
- 12, 13 (email happy-path) — need a real test inbox.
- 15, 16 (Turnstile/Google) — need owner runbook B4.1 (Google client) + B4.3 (Turnstile widget) + the secrets/var.
