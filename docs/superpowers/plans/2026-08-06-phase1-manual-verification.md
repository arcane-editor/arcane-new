# Phase 1 Manual Verification — Auth Correctness

Branch: `heads/v0.3.0`. Environment: **dev only**
(`dev.arcaneai.org` / `api-dev.arcaneai.org`).

Automated coverage at the end of Phase 1:

| Package | Result |
|---|---|
| `arcane-server` | 161 tests / 24 files, `tsc --noEmit` clean |
| `editor` | 994 tests / 88 files, `tsc --noEmit` clean, deep-module boundaries OK |
| `landing-page` | 24 tests, `tsc --noEmit` clean, `astro build` 27 pages |

Everything below is what automation *can't* reach: real browsers, real OS
scheme routing, real cold starts.

---

## 0. Deploy to dev

Merging `heads/v0.3.0` into `dev` deploys automatically — no manual wrangler
steps. Three workflows fire on that push, by path:

| Path touched | Workflow | Effect |
|---|---|---|
| `arcane-server/**` | Deploy Server | `d1 migrations apply arcane-db-dev` **then** `wrangler deploy --env dev` |
| `landing-page/**` | Deploy Landing | Pages deploy to `arcane-landing-dev` |
| `editor/**` | Dev Build | builds the side-by-side "Arcane Dev" app |

This phase touches all three, so expect all three to run.

> **Migrations run before the deploy**, so new code never sees an old schema.
> That means **`0017` drops `device_codes` automatically** on this merge. It is
> destructive: any sign-in mid-device-flow at that moment is abandoned. Device
> codes lived 15 minutes, so merge outside a burst of sign-ins.

Wait for all three workflows to go green before running the checks below — a
red Deploy Server means the schema and the Worker may disagree.

- [ ] `curl https://api-dev.arcaneai.org/health` → `{"status":"ok"}`
- [ ] `curl -X POST https://api-dev.arcaneai.org/v1/auth/editor/attempt -H 'content-type: application/json' -d '{}'`
      → **400** `invalid_challenge` (a 404 means the deploy is stale)
- [ ] `curl -X POST https://api-dev.arcaneai.org/v1/auth/device/code`
      → **404** (the device flow is gone)
- [ ] Landing page CSS asset hash in a local `dist/index.html` matches the live
      page — matching hashes prove the deploy actually landed rather than
      merely reporting success

---

## 1. The regression this phase exists for

- [ ] Sign up on the website with **email + password** (not Google). Do **not**
      click the verification link.
- [ ] Sign in to the editor, open the AI panel, send any prompt.
- [ ] **Expected:** a "Verify your email" panel naming your address.
      **You stay signed in.** No "your session expired" notice anywhere.
- [ ] Before this phase, this signed you out and looped forever on retry.
- [ ] Click **Resend verification email** → confirmation notice appears.
- [ ] Click resend 4× in a row → the 4th shows the throttle message
      ("You've requested several emails already…"), still signed in.
- [ ] Click the link in the email, then **I've verified — retry** → the AI
      responds normally.

## 2. Google path (auto-verified)

- [ ] Sign up with Google, sign in to the editor, send a prompt.
- [ ] **Expected:** works immediately — no verification panel
      (`createOAuthUser` sets `email_verified = 1`).

## 3. Session integrity

- [ ] While signed in, have the server return a genuine 401 (e.g. bump
      `token_version` in D1 for your user, then send a prompt).
- [ ] **Expected:** signed out with "Your session expired…". This is the one
      case that may end a session.

## 4. Sign-in with the app already running

- [ ] Editor open → **Sign In** → browser opens `/auth?flow=editor&…`
- [ ] Confirm the URL carries `attempt=<uuid>`, `state`, `challenge`, and
      either `scheme=` or `redirect_uri=` (never both).
- [ ] Complete sign-in → returned to the app, signed in.
- [ ] **Plan and credit balance are populated immediately** — no `—` flash in
      the account view while a second request lands.

## 5. Cold start — the app was NOT running

This is the journey that silently failed before this phase.

- [ ] Editor open → click **Sign In** → browser opens.
- [ ] **Quit the editor completely** before finishing in the browser.
- [ ] Finish sign-in in the browser → click **Open Arcane**.
- [ ] **Expected:** the app launches and is already signed in.

## 6. Cold start with nothing to match (re-initiate)

- [ ] With the editor **not running** and no sign-in ever started from it,
      open the handoff link from the website.
- [ ] **Expected:** the app launches, briefly bounces through the browser
      (which already has a session), and lands signed in. No second login.
- [ ] Repeat after clearing the app-data dir — same outcome.

## 7. Poll channel (filtered loopback)

- [ ] On a macOS **dev** build (loopback transport), block the loopback port
      with a firewall rule, or kill the listener after the browser opens.
- [ ] Complete sign-in in the browser.
- [ ] **Expected:** the app still signs in within ~2–4 seconds, via poll.

## 8. Replay and cancellation

- [ ] Start a sign-in, complete it, then paste the **same** callback URL again.
      **Expected:** nothing happens; no second session.
- [ ] Start a sign-in, click **Cancel**, then trigger the callback.
      **Expected:** ignored.
- [ ] Start a sign-in, wait for the success page, copy the code, wait **>60s**,
      then paste it into the app. **Expected:** rejected (the code's own TTL is
      60s even though the attempt lives 10 minutes).
- [ ] Paste a code with one character changed. **Expected:** the same opaque
      "Invalid or expired code" — no hint about which part was wrong.

## 9. Multi-window

- [ ] Open two editor windows, sign in from one.
- [ ] **Expected:** the other reflects the signed-in state (via `auth-changed`).
- [ ] Sign out in one → the other returns to the sign-in gate.

## 10. Device flow is gone

- [ ] The editor's Account view shows **no** "Use a device code instead" link.
- [ ] `https://dev.arcaneai.org/auth/device` → 404.
- [ ] All three `/v1/auth/device/*` endpoints → 404 (covered in §0).

---

## Notes

- `DODO_WEBHOOK_SECRET` is a Worker secret, not a `wrangler.toml` var, so it is
  not carried by the deploy. It does not affect anything in Phase 1, but
  `/v1/billing/webhook` answers 503 until it is set, and Phase 2/3 cannot be
  verified end to end without it.
