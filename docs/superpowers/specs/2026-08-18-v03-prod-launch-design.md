# v0.3 Production Launch — Live Dodo Payments + Free-Plan Credit Rule

**Date:** 2026-08-18
**Status:** Approved design, ready for implementation planning

Two pieces of work ship together:

1. **A code change** — users on the Free plan cannot buy credit top-ups.
2. **The first production cutover** — auth, AI, and billing go live on
   `arcaneai.org` / `api.arcaneai.org`, with real (non-test) Dodo Payments.

## Starting state (measured 2026-08-18)

| Fact | Value |
|---|---|
| `api.arcaneai.org/health` | 200 — but `/v1/billing/plans` → 404 |
| `arcaneai.org/pricing`, `/auth` | 404 |
| Prod worker secrets | `JWT_SECRET` only |
| Prod D1 unapplied migrations | 10 (`0012`–`0021`, incl. `0013_billing`) |
| Prod D1 contents | 9 users, 70 request logs, 7 usage periods |
| `master` | v0.2.2 |
| `dev` | 414 commits ahead of `master` |
| Dodo MCP | authenticated against **test** mode |
| Dodo test products | 5, matching `src/config/tiers.ts` |
| Dodo test webhook | `ep_3HizO4n2sOp4JKd4F9Wd7KX5qsU` → `api-dev.arcaneai.org/v1/billing/webhook`, all event types |

Prod runs the pre-Phase-2a server. The entire auth + AI + billing stack is
going live at once, on a database that has never seen migration `0012`.

## Decisions

- **Sign-in at launch:** email + GitHub. Google and Turnstile stay unset;
  both degrade gracefully (Google start 302s to `?error=google_not_configured`,
  Turnstile verification is skipped) and become secrets-only follow-ups with
  no code change.
- **Sequencing:** two windows, billing dark in the first. Auth and AI run for
  real on prod while payments stay closed, then payments open separately.
- **Execution split:** everything that can be automated is; the owner does
  only what an API cannot — register the GitHub OAuth App, supply a live-mode
  Dodo API key, and make the first real purchase.

---

## Part 1 — Free-plan credit rule

### Server (the gate)

`arcane-server/src/routes/billing.ts`, `POST /v1/billing/checkout`. The
handler already loads the user row; hoist that fetch above the tier/pack
branch and, **in the `pack` branch only**, allow the checkout solely when the
plan is a *known paid tier* — `isTierId(plan) && plan !== 'free'`. Anything
else (free, or an unrecognised value) is rejected with
`403 {error, code: 'plan_required'}`.

Failing closed on an unknown plan string matters: an allowlist means a future
tier id, a typo, or a corrupted row can never accidentally open a purchase
path. It also keeps the server and the client predicate on identical logic.

Authority is `users.plan` read from D1, never the JWT claim — a stale token
must not be able to buy past the gate.

Two deliberate non-changes:

- **Tier checkout stays open to free users.** That is the upgrade path
  itself; breaking it would be the worst possible regression here. It gets an
  explicit test.
- **The webhook never gates.** `payment.succeeded` grants top-up credits
  regardless of plan. If Dodo took the money, we owe the credits — refusing
  there would charge a customer and deliver nothing. The only correct place
  to say no is *before* a checkout exists.

Subscription states fall out of reading `users.plan` with no special-casing:
`on_hold` (dunning) keeps the paid plan and may still buy; `cancelled`
reverts to free and is blocked.

`GET /v1/billing/plans` keeps listing top-up packs — it is public, it carries
no user state, and the locked cards need the data to render.

### Website

`landing-page/src/lib/billing.ts` gains a pure `canBuyTopups(plan: string)`
predicate, unit-tested in `src/lib/billing.test.ts` (the existing landing
tests live only under `src/lib`; there is no component-test harness).

`landing-page/src/components/billing/BillingPanel.tsx` keeps rendering the
pack cards on the free plan but disabled, captioned "Upgrade to Pro to buy
credits" and linking to `/pricing`. `buyTopup` also handles a `403` by
surfacing the server's message, so a stale client-side plan produces a clear
explanation rather than a silent dead click.

No editor change: the editor links out to the website for all billing.

### Tests (written first)

Server (`arcane-server/test/`):

- free plan + `{pack}` → 403 `plan_required`
- free plan + `{tier}` → not blocked (upgrade path intact)
- paid plan + `{pack}` → proceeds to checkout creation
- plan reverted to free after cancellation + `{pack}` → 403

Landing (`src/lib/billing.test.ts`): `canBuyTopups` false for `free`, true
for each paid tier, false for an unknown plan string (fail closed).

---

## Part 2 — Production cutover

### Window 0 — pre-flight (prod untouched)

1. **Green-build gate on `dev`.** `arcane-server`: `npm run check:types`,
   `npm test`. `editor`: `bunx tsc --noEmit`, `bun test src`.
   `landing-page`: `pnpm exec astro sync`, `pnpm exec tsc --noEmit`,
   `pnpm test`, `pnpm build`.
2. **Implement Part 1** (TDD).
3. **Prove billing end-to-end in Dodo test mode on the dev stack.** This has
   never actually run. dev already has test products, both Dodo secrets, and
   a registered webhook endpoint. A real test-card purchase against
   `dev.arcaneai.org`, watched with `wrangler tail --env dev`, yields the
   **actual event names** — the one thing the API reference did not settle.
   The handler switches on `subscription.active|renewed|on_hold|cancelled|failed`
   and `payment.succeeded|failed`; any mismatch is a code fix here, not a
   silent non-grant after a real charge. Also confirms whether renewals echo
   checkout metadata (the handler already falls back to the stored
   subscription row if they do not).
4. **Migration rehearsal.** `wrangler d1 export arcane-db --remote` → import
   into a fresh local D1 → apply `0012`–`0021` → confirm clean, and that the
   9 existing users land on sane `plan` / `plan_credits_micro` /
   `plan_period_end` defaults. `0013`'s `ADD COLUMN`s are not idempotent, so
   a partial failure on the real DB means reconciliation; rehearsing removes
   that risk cheaply.
5. **Merge `dev` → `master`** (`--no-ff`), CI green on `master`. Both prod
   deploy jobs are gated on `github.ref == 'refs/heads/master'`.

Already verified against the live API reference, so no code change is
expected: `POST /checkouts` takes `product_cart` / `return_url` / `metadata` /
`customer` and returns `{session_id, checkout_url}`; `POST
/customers/{id}/customer-portal/session` returns `{link}`. Both match
`src/lib/dodo.ts` exactly.

### Window 1 — prod stack live, billing dark

6. **Record a D1 Time Travel bookmark** (`wrangler d1 time-travel info
   arcane-db`) immediately before migrating. This is the restore point.
7. **Owner registers the prod GitHub OAuth App**, callback
   `https://api.arcaneai.org/v1/auth/github/callback` (GitHub allows one
   callback per App, so prod needs its own, separate from dev's). Set
   `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` via `wrangler secret put`.
8. **Dispatch `deploy-server.yml`** with `environment=production`. The job
   applies migrations *before* deploying, so new code never sees an old
   schema.
9. **Dispatch `deploy-landing.yml`** with `environment=production` —
   typechecks, tests, builds with `PUBLIC_API_URL=https://api.arcaneai.org`,
   and publishes to the `arcane-landing` Pages project.
10. **Verify on prod:** email signup + OTP delivery, GitHub sign-in, AI chat
    streaming, `request_logs` / `usage_periods` rows landing, `/account`
    showing Free with 150 credits, and `POST /v1/billing/checkout` returning
    **503 `billing_unconfigured`** — the proof that payments are closed.

Billing being dark is not a special build: with `DODO_API_KEY` unset the
checkout and portal routes return 503 by design, and the webhook returns 503
rather than trusting an unsigned payload.

### Window 2 — live money

11. **Owner points the Dodo MCP at a live-mode API key.**
12. **Create the 5 live products**, mirroring test exactly: Pro $20, Pro+ $50,
    Ultra $200 (recurring monthly); 1,600 credits $16, 7,500 credits $75
    (one-time). All `tax_category: saas`. Prices come from
    `src/config/tiers.ts`, which stays the single source of truth.

    **Name the live top-up products for the credits they actually grant** —
    "Arcane 1,600 Credits" and "Arcane 7,500 Credits". The test products are
    named "1,000" / "5,000" from an earlier grant size and are stuck that way
    (renaming would orphan them, per the note in `tiers.ts`), but the live
    products are new, and a customer-facing name that contradicts the delivered
    credits is a support ticket on day one. The internal
    `DODO_PRODUCT_TOPUP_1000` / `_5000` var names and the `topup_1000` /
    `topup_5000` pack ids stay as they are — they are internal references and
    renaming them buys nothing.
13. **Create the live webhook endpoint** via `webhooks.create`
    (`https://api.arcaneai.org/v1/billing/webhook`, all event types), then
    read its signing secret via `webhooks.retrieveSecret` and set
    `DODO_WEBHOOK_SECRET`. The live API key from step 11 is also the value of
    the `DODO_API_KEY` worker secret — one key, set in two places (the MCP
    connection and `wrangler secret put`).
14. **Fill the five `DODO_PRODUCT_*` vars** in `wrangler.toml` `[vars]`,
    commit, redeploy. (Secrets take effect immediately; vars need a deploy.)
15. **Real-money proof**, in order:
    - Owner buys Pro with a real card → `subscription.active` → plan flips to
      `pro`, 2,000 credits granted, `/account` reflects both.
    - A free-plan account confirms the new rule: locked cards on `/account`,
      and a direct `POST /v1/billing/checkout {pack}` → 403 `plan_required`.
    - A top-up purchase on the Pro account → `payment.succeeded` → credits
      added.
    - Cancel via the hosted portal → `subscription.cancelled` → downgrade to
      free with top-up credits preserved.
16. **Tag `v0.3.0`** → `release.yml` builds macOS (arm64) and Windows x64
    installers and uploads them to the `arcane-releases` R2 bucket.

### Rollback

| Failure | Response |
|---|---|
| Migration fails partway | D1 Time Travel restore to the bookmark from step 6 |
| Worker regression | `wrangler rollback` to the prior version |
| Billing misbehaving | `wrangler secret delete DODO_API_KEY` — checkout returns 503 again while auth and AI keep serving; the webhook still verifies, so in-flight payments still grant |
| Landing regression | Redeploy the prior Pages deployment |

The billing kill switch is deliberate: it closes the money path in one
command without touching anything else, and without stranding a payment that
Dodo has already taken.

## Out of scope

- Google sign-in and Turnstile (secrets-only follow-ups, no code change).
- Refund and dispute handling: `dispute.*` / `refund.*` events are logged but
  not acted on. Revocation rules are an owner decision and a separate change.
- Credit reservation ledger (deferred from the 2026-08-16 harness review).
- Re-pricing. `src/config/tiers.ts` ships as-is; model rates in `costs.ts`
  are vendor list prices verified 2026-08-13/15.

## Known risk, accepted for v0.3

Free tier grants 150 credits/month plus a $1/month inline-completion ceiling
with no card required — roughly $1.75 of real model spend per free account
per month. With Turnstile unset, signup is throttled only by the per-IP rate
limiter. This is the main abuse surface at launch. Accepted for v0.3;
Turnstile is a secrets-only mitigation if abuse appears.
