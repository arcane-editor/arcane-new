# Billing (Dodo Payments) — Verification & Cutover Gate

Subscription plans + AI credits. Code-complete on `dev` (commits `33731a5..23e33a7`). This is the merge/cutover gate: automated gates below are green; the **owner prerequisites** and **manual e2e** are what remain before real money flows.

## Automated gates — PASS (2026-07-20)
- `arcane-server`: `npm run check:types` clean; `npm test` → **112 pass** (metering, credit ledger/debit ordering, credit gate 402, Standard-Webhooks HMAC verify + replay + idempotency + subscription lifecycle incl. metadata-less renewal fallback).
- Migration `0013_billing.sql` applies clean on local D1 (`wrangler d1 migrations apply arcane-db --local`) and the vitest harness.
- `editor`: `bunx tsc --noEmit` clean; `bun run check:modules` clean; `bun test src` → **797 pass**.
- `landing-page`: `astro build` green (28 pages incl. `/pricing`). NOTE: no `typescript` is installed in this checkout, so full `tsc` on the landing TSX could not run — build resolves imports + transforms TSX only. Install `typescript` and run `tsc --noEmit` before prod for a full type gate.

## What's built (all on `dev`, NOT merged to master)
- **B1** metering: all four AI routes write `request_logs`/`usage_periods` (was chat-only); bge-small added to the cost catalog.
- **B2** credit engine: migration 0013 (plan + micro-USD credit buckets, `subscriptions`, `billing_events`); `src/config/tiers.ts` pricing source; `checkAiBudget` (402/429) on all AI routes; `recordUsage` debits (plan-then-topup); plan+credits on `makeUserResponse` + `/v1/usage`.
- **B3** Dodo: `src/lib/dodo.ts` (WebCrypto HMAC verify + checkout/portal fetch clients); `src/routes/billing.ts` (`/v1/billing/plans|checkout|portal`); public `src/routes/billing-webhook.ts`.
- **B4** website: `/pricing` (PricingTable) + account `BillingPanel` + `src/lib/billing.ts`.
- **B5** editor: AuthTab shows plan + credits; 402 → refresh + actionable message; "Manage plan & credits" opens the website.

## OWNER PREREQUISITES (blocking real billing)
1. **Dodo account + KYC** (Merchant-of-Record requires business verification).
2. **Create products** in Dodo **test** AND **live**: one subscription product per paid tier (Pro/Pro+/Ultra) and one one-time product per top-up pack. Capture their product ids.
3. **Set secrets/vars** (dev first, then prod):
   - `wrangler secret put DODO_API_KEY [--env dev]`
   - `wrangler secret put DODO_WEBHOOK_SECRET [--env dev]` (per-endpoint Standard-Webhooks signing key)
   - Fill the product-id vars in `wrangler.toml` `[vars]` (prod) and `[env.dev.vars]` (test): `DODO_PRODUCT_PRO/PROPLUS/ULTRA/TOPUP_1000/TOPUP_5000`.
4. **Register the webhook endpoint** in the Dodo dashboard: `https://api-dev.arcaneai.org/v1/billing/webhook` (test) then `https://api.arcaneai.org/v1/billing/webhook` (live).
5. **Real Cloudflare neuron costs**: pull actual $/token for `qwen2.5-coder-32b`, `kimi-k2.7-code`, `glm-5.2`, `bge-small` from the CF dashboard → replace the placeholder rates in `src/lib/costs.ts` → finalize tier prices/grants in `src/config/tiers.ts` (see the plan's Pricing model + the Ultra break-even caveat).

## CONFIRM against live Dodo docs before go-live (couldn't verify offline)
- **Checkout**: `createDodoCheckout` posts `POST {base}/checkouts` with `product_cart`/`return_url`/`metadata`. Confirm endpoint + body + that the response carries `checkout_url`.
- **Portal**: `createDodoCustomerPortal` posts `POST {base}/customers/{id}/customer-portal/session`. Confirm.
- **Webhook event names**: handler maps `subscription.active|renewed|on_hold|cancelled|failed` + `payment.succeeded|failed`. Confirm the exact **cancellation/refund** event names and wire refund/dispute revocation (currently logged, not acted on).
- **Metadata echo**: we set `metadata.arcane_{user_id,kind,ref}` at checkout and read it back on events. Renewals fall back to the stored `subscriptions` row if metadata is absent — confirm whether Dodo echoes checkout metadata on `subscription.renewed`.
- **Base URL**: `dodoApiBase` returns live only when `ENVIRONMENT==='production'`. Footgun: local `wrangler dev` uses the base `[vars]` (`ENVIRONMENT="production"`) → would pick the LIVE host, but with no `DODO_API_KEY` set locally the checkout routes 503 (safe). Set a local `.dev.vars` `ENVIRONMENT="development"` if exercising checkout locally.

## MANUAL e2e (dev stack, Dodo TEST mode) — the proof
Once prerequisites 1–4 are done on dev:
1. Sign in on `dev.arcaneai.org` → `/pricing` → **Choose Pro** → redirected to Dodo test checkout → pay with a test card → returns to `/account?checkout=success`.
2. `wrangler tail --env dev`: webhook received, signature verified, user flipped to `pro`, ~1,400 credits granted; `/account` BillingPanel shows Pro + balance.
3. In Arcane Dev: Account tab shows Pro + credits; run chat/embeddings/graph until credits hit 0 → AI returns **402**, editor shows the out-of-credits message → "Manage plan & credits" opens `/account`.
4. **Buy a top-up pack** → test checkout → `payment.succeeded` → top-up credits added → AI streams again.
5. **Idempotency**: re-trigger the same webhook (`dodo wh trigger`) → response `{ok:true,duplicate:true}`, no double grant.
6. **Renewal**: simulate `subscription.renewed` (with and without metadata) → credits reset to the plan grant, tier preserved.
7. **Cancel**: cancel in the Dodo portal → `subscription.cancelled` → account downgrades to Free (top-up credits preserved).

## PROD CUTOVER (fold into auth Phase 4)
Same sequence as the auth cutover, plus: prod migration `0013` (ADD COLUMN is NOT idempotent — partial fail = manual reconcile), live Dodo secrets + product ids, live webhook endpoint registered, then the `v*` app tag. Verify a real (small) live subscription end-to-end before announcing.
