# Auth, Onboarding & Subscription Lifecycle — v0.3.0 Design

**Date:** 2026-08-06
**Branch:** `heads/v0.3.0` (cut fresh from `dev` @ 2936505; the pre-existing
`heads/v0.3.0` was an ancestor of `dev` with 0 unique commits and was replaced)
**Target environment:** dev only (`dev.arcaneai.org` / `api-dev.arcaneai.org`).
Promotion to `dev` and then `master` happens after this branch is verified.

---

## 1. Problem

Arcane's auth and billing foundations are strong — PKCE editor login, a
`token_version` revocation epoch, a micro-USD credit ledger, signed Dodo
webhooks with an idempotency ledger, 147 passing tests. The gaps are specific
defects plus three mechanisms that were never built.

### 1.1 The 403 logout loop (highest severity)

`editor/src/features/ai-panel/services/arcane-stream.ts:309` treats 403
identically to 401:

```ts
if (attemptResponse.status === 401 || attemptResponse.status === 403) {
    …setAuthNotice('Your session expired and you were signed out.')
    await useAuthStore.getState().logout()
```

But `requireVerifiedEmail()` (`arcane-server/src/middleware/auth.ts:101`)
returns **403 `email_unverified`** for a valid session, and it gates every AI
route.

Resulting loop for any email/password signup who has not yet clicked the
verification link: sign up → handed to editor → signed in → first AI message →
403 → **editor logs them out** claiming the session expired → sign in again →
identical failure, indefinitely.

Google signups are auto-verified (`createOAuthUser` sets `email_verified = 1`),
so this affects only the email/password path — which is why it presents as
intermittent rather than as a hard break.

### 1.2 Cold-start deep links cannot complete a login

`editor/src/features/auth/services/browser-login.ts:11-13` states the
constraint outright: the PKCE verifier is memory-only, so "a cold-start deep
link therefore cannot complete a login, by design".

The product intent is website-first authentication with a deep-link redirect
into the app. In that flow the app is frequently **not running**, so the
callback is dropped and the user lands in a fresh, signed-out app with no
explanation.

### 1.3 No subscription lifecycle mechanism

`wrangler.toml` has no `[triggers]`; `arcane-server/index.ts` has no
`scheduled()` export. Nothing reconciles billing state. Therefore:

- `subscription.on_hold` retains the paid plan and credits **forever**. The
  handler comments that it records status "so the account UI can warn", but
  `/v1/usage` never returns subscription status, so no UI can warn.
- A paid plan whose `plan_period_end` passes keeps its label and balance
  indefinitely — `refreshAndGetBalance` (`src/lib/credits.ts:29`) resets **only**
  the free tier.
- Webhook delivery is at-most-once *by design* (`src/lib/db.ts:315-321`: "a
  crash between recording and applying loses that delivery"). With no
  reconciliation, one lost `subscription.cancelled` is a permanent free ride.
- `dispute.*` / `refund.*` fall through to `default` and only log.

### 1.4 Mid-cycle plan changes destroy credits

`grantPlanCredits` (`src/lib/db.ts:252`) **SETs** the plan bucket. Pro → Ultra
wipes unused Pro credits; Ultra → Pro drops 16,000 → 1,400 instantly.
`subscription.plan_changed` / `.updated` are not in the switch.

### 1.5 Smaller defects

- **Exchange contract drift.** `mintAuthResponse` → `makeUserResponse` returns
  `plan` and `credits`, but `editor/src/features/auth/services/auth-client.ts`
  types the response as `{id, email, role, emailVerified}` and
  `stores/auth.ts:83` hardcodes `plan: null`. The editor discards data it
  already has and needs a second `/v1/usage` round-trip; the account panel
  shows `—` until it lands.
- **`/v1/auth/device/*` is a PKCE-less parallel login path**, wired into the
  editor UI as "Use a device code instead". Its user code is 8 characters from
  a 32-character alphabet, protected only by rate limits. Neither Cursor nor
  Zed ships an equivalent.
- **No onboarding.** `editor/src/WelcomeApp.tsx` — the first window a user
  sees — has zero auth awareness. Sign-in is reachable only through a virtual
  `auth://account` file tab opened from the AI panel gate.

---

## 2. Decisions

Settled during brainstorming; recorded here because they constrain everything
downstream.

| # | Decision | Rationale |
|---|---|---|
| D1 | One spec, four ordered phases | The phases share one user journey and one data model; Phase 1 is independently shippable |
| D2 | Payment failure → **fixed 7-day grace, then revoke to Free** | Matches Dodo's retry schedule and Cursor/Stripe dunning; directly implements "revoke if not paid within a certain time" |
| D3 | **Upgrade immediate, downgrade at period end** | Cursor's model; never destroys credits a user paid for; bounded against farming since every upgrade is a real charge |
| D4 | Handoff = **persist attempt + re-initiate fallback + PKCE-bound poll** | Covers all three delivery channels with no bearer token in any URL |
| D5 | **Full first-run onboarding, auth-scoped only** | Unity/bridge setup is deliberately excluded to keep this spec bounded |

**Invariant across all phases: top-up credits are never revoked** by grace,
downgrade, cancellation, or reconciliation. They were purchased outright. The
single exception is `refund.succeeded` for the specific top-up pack refunded.

---

## 3. Data model

Two migrations, split along the phase boundary so each phase ships working,
independently testable software:

- `0016_editor_attempts.sql` — Phase 1: the `editor_attempts` table (§3.3) and
  the `device_codes` drop (§3.4).
- `0017_subscription_lifecycle.sql` — Phases 2–3: the `users` and
  `subscriptions` columns (§3.1, §3.2).

Per the precedent in `0013_billing.sql`, `ALTER TABLE ADD COLUMN` is **not**
idempotent — a partial failure is reconciled by hand, never blind re-run.

### 3.1 `users` — additive columns

Denormalized onto `users` so the AI budget gate stays at one PK-indexed read.

| column | type | default | purpose |
|---|---|---|---|
| `plan_status` | TEXT NOT NULL | `'active'` | `active` \| `grace` |
| `grace_until` | TEXT | NULL | ISO-8601 UTC; when a `grace` user is revoked to Free |
| `pending_plan` | TEXT | NULL | Scheduled downgrade target tier id |
| `pending_plan_at` | TEXT | NULL | ISO-8601 UTC; equals `current_period_end` |

### 3.2 `subscriptions` — additive columns

| column | type | default | purpose |
|---|---|---|---|
| `grace_until` | TEXT | NULL | Mirror of the user-level grace deadline |
| `cancel_at_period_end` | INTEGER NOT NULL | `0` | Cancellation scheduled at the boundary |

`status` gains `expired` to its documented value set (`active` | `on_hold` |
`cancelled` | `failed` | `expired`).

### 3.3 `editor_attempts` — new table

Replaces `device_codes`. Unlike it, every attempt is PKCE-bound at creation.

```sql
CREATE TABLE IF NOT EXISTS editor_attempts (
    attempt_id  TEXT PRIMARY KEY,
    challenge   TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',   -- pending | authorized
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
    code_hash   TEXT,
    consumed_at TEXT,
    expires_at  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_editor_attempts_expires ON editor_attempts(expires_at);
```

### 3.4 Removal

`DROP TABLE IF EXISTS device_codes;` in the same migration.

---

## 4. Phase 1 — Auth correctness

### 4.1 Split 401 from 403

In `arcane-stream.ts`, branch on the error **code**, never the bare status:

- `401` → session genuinely invalid → logout. Unchanged behaviour.
- `403` with `error === 'email_unverified'` → **never log out.** Set a new
  `verificationRequired` flag in the AI store.
- `403` otherwise → surface the message, preserve the session.

The AI panel renders a verification state showing the signed-in address, a
**Resend verification email** button (`POST /v1/auth/resend-verification`,
already implemented in `routes/auth-email.ts`), and a retry control.

**Prevention over recovery:** `mintAuthResponse` already returns
`emailVerified`, so the editor knows at sign-in time. The AI panel shows the
verification state proactively rather than after a failed prompt.

**Generalized invariant — only 401 ends a session.** Every 403, 5xx, timeout
and network failure preserves it.

### 4.2 Repair the exchange contract

Widen `ExchangeResult`'s user type in `auth-client.ts` to include `plan` and
`credits`, and consume both in `stores/auth.ts` instead of hardcoding
`plan: null`. Removes a round-trip and the `—` placeholder in the account view.

### 4.3 Handoff: persist + re-initiate + poll

The attempt row **is** the grant, so all channels converge on one atomic
single-use consume (the `consumed_at IS NULL` predicate already proven in
`consumeAuthToken`).

```
app  POST /v1/auth/editor/attempt {challenge}  → {attempt_id, expires_in}
app  persist {attempt_id, state, verifier} to app-data dir, TTL 10 min
app  open browser → /auth?flow=editor&state=…&attempt=<id>[&scheme|&redirect_uri]
web  POST /v1/auth/editor/grant {attempt_id}   → {code}          (authenticated)
     ├─ fast path: deep link / loopback carries code
     │             → POST /v1/auth/editor/exchange {code, verifier}
     └─ backstop:  app polls
                   → POST /v1/auth/editor/poll {attempt_id, verifier}
                     428 authorization_pending | 200 {token, user}
```

**Endpoints**

- `POST /v1/auth/editor/attempt` — public. Body `{challenge}` validated against
  the existing `/^[A-Za-z0-9_-]{43,128}$/`. Creates a `pending` row, TTL 10
  minutes. Opportunistically cleans expired rows, mirroring
  `cleanExpiredAuthTokens`.
- `POST /v1/auth/editor/grant` — authenticated. Accepts `{attempt_id}`; also
  continues to accept the existing `{challenge}` form so a stale client build
  keeps working during dev rollout. The legacy `{challenge}` form **creates an
  `editor_attempts` row on the fly** with a server-generated `attempt_id` and
  an immediate `authorized` status, so both forms share exactly one storage
  path and one consume path. Either way: sets `user_id`,
  `status = 'authorized'`, `code_hash`; returns the raw `code`.
- `POST /v1/auth/editor/exchange` — unchanged signature and unchanged opaque
  single-error contract; now resolves against `editor_attempts` rather than
  `auth_tokens`. The `editor_login` entry in `TOKEN_TTL_SECONDS` retires with
  it; `auth_tokens` keeps serving `verify_email`, `password_reset` and
  `web_login` (the Google → website handoff) unchanged.
- `POST /v1/auth/editor/poll` — public. Body `{attempt_id, verifier}`. Returns
  `428 authorization_pending` while `pending`; on `authorized`, verifies
  `s256(verifier) === challenge`, consumes atomically, returns
  `mintAuthResponse`. Every failure mode returns one opaque `invalid_attempt`,
  matching the exchange endpoint's no-oracle rule.

**Client behaviour**

- *Cold start (D4-A).* Read the launch URL through the deep-link plugin's
  `getCurrent()`, load the persisted attempt, match `state`, exchange.
  Persisting the verifier is acceptable here because `authClient.saveToken`
  already writes the **30-day JWT** to the same directory — a 10-minute
  verifier is strictly less valuable than what is already at rest. The record
  is deleted on use and on expiry.
- *Unmatched deep link (D4-C).* If a callback arrives with no matching
  persisted attempt — a genuine website-initiated start, an expired attempt, a
  wiped data dir — the app silently begins its own PKCE attempt and reopens the
  browser. The browser already holds a session, so it completes without a
  second login and hands straight back.
- *Poll.* Runs concurrently with the deep-link/loopback listener at a 2-second
  interval, bounded by the same 10-minute attempt timeout. It covers
  environments where loopback sockets are filtered — the case
  `AuthSuccess.tsx:23` already documents.

Exactly one channel can win: both terminate in the same atomic consume.

Both new endpoints are rate-limited through the existing `RL_AUTH_POLL`
binding, registered in `index.ts` alongside the current entries.

### 4.4 Delete the device flow

Remove the three `/v1/auth/device/*` routes, the `device_codes` table and its
six `db.ts` helpers, the `AuthTab` device UI and mode toggle, the
`requestDeviceCode`/`pollDeviceToken` client methods, and
`test/auth-routes.test.ts`'s device cases. The poll channel supersedes it with
PKCE binding.

---

## 5. Phase 2 — Subscription lifecycle

### 5.1 Scheduled reconciliation

`wrangler.toml` gains, for both `[env.dev]` and the default environment:

```toml
[triggers]
crons = ["17 * * * *"]
```

Offset off the hour to avoid the platform-wide top-of-hour stampede.
`arcane-server/index.ts` changes from `export default app` to an object
exporting both `fetch` and `scheduled`.

**Job** (`src/lib/reconcile.ts`), bounded to 200 users per run so a Worker CPU
limit cannot be reached:

1. Select users where `plan != 'free'` **and** (`grace_until` has passed **or**
   `plan_period_end` is more than 24 hours stale).
2. For each, query Dodo for the authoritative subscription state.
3. Act on a **positive** answer only:
   - Dodo says cancelled/expired/failed → downgrade to Free.
   - Dodo says active → re-grant and clear grace.
   - No answer, network error, or unparseable response → **leave untouched**
     and log for the next run.

Step 3 makes a lost webhook self-healing in both directions, which is required
because delivery is at-most-once by design.

The same job applies matured `pending_plan` rows (§6) via a shared
`applyPendingPlan()`.

The 24-hour slack absorbs late renewals and clock skew rather than punishing
them.

### 5.2 Webhook cases

Added to `handleBillingEvent`:

| event | effect |
|---|---|
| `subscription.on_hold` | `plan_status = 'grace'`, `grace_until = now + 7 days`; plan and credits untouched |
| `subscription.renewed` / `.active` | clear `grace_until`, `plan_status = 'active'` (in addition to the existing grant) |
| `subscription.plan_changed` / `.updated` | Phase 3 logic (§6) |
| `subscription.expired` | downgrade to Free, same path as `cancelled` |
| `refund.succeeded` | reverse the matching top-up pack's credits, floored at 0 |
| `dispute.opened` | revoke to Free and zero **plan** credits; log for manual review |

The existing `billing_event_unresolved_tier` guard — never grant Free credits
to a paying customer on an unresolvable event — is preserved and extended to
the reconciliation job.

### 5.3 Make status visible

`GET /v1/usage` additionally returns `planStatus`, `graceUntil`,
`cancelAtPeriodEnd`, `pendingPlan`, `pendingPlanAt`.

- `landing-page/src/components/billing/BillingPanel.tsx` renders a dated
  warning while in grace: *"Payment failed. Update your card by Aug 13 or your
  plan moves to Free."* with a direct link to the Dodo customer portal.
- The editor's account view renders the same warning, and the AI panel shows a
  compact banner.

This is the missing half of the existing `on_hold` handler, which records
status for a UI that currently has no way to read it.

---

## 6. Phase 3 — Tier changes

A single helper, `isUpgrade(from, to)`, comparing the `order` field already
present on every entry in `config/tiers.ts`.

**Upgrade — immediate.** Set `plan` to the new tier and SET the plan bucket to
its grant. Dodo prorates the charge. SET is safe because an upgrade's target
grant is always larger than the current tier's.

**Downgrade — scheduled.** Write `pending_plan` and
`pending_plan_at = current_period_end`; change nothing else. The user keeps the
tier and credits they paid for until the boundary.

**Cancellation** sets `cancel_at_period_end = 1` and follows the same boundary
path to Free.

**One boundary applier.** `applyPendingPlan(userId)` is called by whichever
arrives first — the renewal webhook or the hourly cron — and is idempotent, so
the two can never disagree.

**UI.** The account views read `pendingPlan` / `pendingPlanAt` and state it
plainly: *"Pro+ until Sep 3, then Pro."*

Top-up credits are untouched by every path in this section.

---

## 7. Phase 4 — First-run onboarding

Gated on a persisted `onboarding_completed` flag in the editor's app-data
store.

**Sequence:** Welcome → Sign in *or* continue without an account → plan & free
credits → open a project.

- "Continue without an account" is a real, unpenalized path. The editor is a
  functional Unity IDE without AI; burying that would be a dark pattern.
- The plan step confirms the free tier's monthly credit grant so a new user
  learns they have credits waiting.

**`WelcomeApp.tsx`** gains a persistent account chip showing plan and credit
balance, opening the account view on click.

**`AiSignInGate`** calls `beginBrowserLogin()` directly instead of opening an
`auth://account` tab that contains another button — one click instead of three.

---

## 8. Error handling

The rules that make the above safe, stated as invariants:

1. **Only 401 ends a session.** Every 403, 5xx, timeout and network error
   preserves it. (§4.1 generalized.)
2. **Never downgrade on ambiguity.** Reconciliation acts only on a positive
   confirmation from Dodo; timeouts and parse failures leave state alone.
3. **Grace beats silence.** A missing renewal enters grace, never immediate
   revocation.
4. **Every credit mutation is idempotent** under webhook redelivery, and the
   cron is safe to run twice within one hour.
5. **One opaque error per auth failure mode.** `poll` follows `exchange`'s
   existing no-oracle contract.
6. **Top-up credits survive everything** except a refund of that specific pack.

---

## 9. Testing

Server tests extend the existing vitest + `test/apply-migrations.ts` harness.
The current 147 tests across 23 files must stay green.

**New server coverage**

- `attempt → grant → exchange` and `attempt → grant → poll`, including the race
  where both channels fire and exactly one wins
- replayed, expired, and wrong-verifier attempts all return one opaque error
- grace entry, grace expiry, and grace *rescue* by a late renewal
- reconciliation in both directions — revoke when Dodo confirms gone, re-grant
  when Dodo confirms active, no-op on an ambiguous response
- upgrade-now / downgrade-at-boundary credit math, including two transitions in
  one cycle
- `refund.succeeded` and `dispute.opened`
- migration `0016` applies cleanly onto a `0015` database

**Editor (bun)** — cold-start resume, re-initiate on unmatched deep link,
persisted-attempt TTL expiry, poll/deep-link race, and `403 email_unverified`
**not** logging out.

**Landing (vitest)** — `attempt_id` parameter handling alongside the existing
`editor-login` validators.

**Manual verification** —
`docs/superpowers/plans/2026-08-06-auth-subscription-manual-verification.md`,
following the existing checklist pattern: real card in Dodo test mode, real
deep link, real cold start, real grace expiry via clock manipulation.

---

## 10. Deployment prerequisites

Both are owner actions and neither blocks writing code.

1. **`DODO_WEBHOOK_SECRET` must be set for the dev Worker.** It is a Worker
   secret, not a `wrangler.toml` var. Without it `/v1/billing/webhook` returns
   503 by design, and no part of Phase 2 or 3 can be verified end to end.
   Dodo test-mode product ids for all five products landed in `wrangler.toml`
   on 2026-08-06.
2. **Deploys are manual.** The CI Cloudflare token is broken, so
   `heads/v0.3.0` will not self-deploy. Migration `0016` needs
   `npx wrangler d1 migrations apply arcane-db-dev --env dev --remote`
   after an interactive `npx --yes wrangler@4 login`, then
   `npx wrangler deploy --env dev`.

---

## 11. Out of scope

Named explicitly so they are not silently absorbed:

- Unity-specific onboarding (version detection, `arcane-extension` bridge
  install) — deliberately excluded from D5.
- Team/organization plans and seat management.
- Promotion of this branch to `dev` or `master`.
- Production Dodo products; only test-mode products exist.
- Re-pricing the tiers. `config/tiers.ts` values remain illustrative pending
  confirmed Cloudflare neuron costs, exactly as documented there today.
