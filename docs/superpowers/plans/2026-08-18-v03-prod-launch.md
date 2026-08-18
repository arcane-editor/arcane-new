# v0.3 Production Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Arcane v0.3 to production with live (non-test) Dodo Payments, and block credit top-up purchases for users on the Free plan.

**Architecture:** Two code tasks (a server-side purchase gate and its website counterpart) followed by five ops tasks that cut production over in two windows — first the full auth + AI stack with payments deliberately closed, then live payments. Every irreversible prod step is preceded by a recorded restore point and followed by an explicit verification command.

**Tech Stack:** Cloudflare Workers (wrangler 4.69, Hono 4.11, D1), vitest 4 + `@cloudflare/vitest-pool-workers`, Astro 5 + React 19 (landing), Tauri 2 (editor), Dodo Payments REST API + MCP, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-18-v03-prod-launch-design.md`

## Global Constraints

- `arcane-server/src/config/tiers.ts` is the SINGLE source of truth for prices, grants, and pack definitions. Never hardcode a price, credit count, or tier list anywhere else — derive it.
- Server TypeScript runs with `noUncheckedIndexedAccess`. `TIERS[someString as TierId]` is `Tier | undefined`; handle the undefined.
- Server tests run from `arcane-server/` via `npm test` (vitest + `@cloudflare/vitest-pool-workers`, config `wrangler.test.toml`). **`DODO_API_KEY` is deliberately unset there**, so any code path past the API-key guard returns 503 in tests. Do not add `DODO_API_KEY` to `wrangler.test.toml`.
- Landing tests live ONLY under `landing-page/src/lib/*.test.ts`. There is no component-test harness (no jsdom, no testing-library). Test pure functions; never write a test that renders a React component.
- **Never gate a purchase in the webhook.** `payment.succeeded` must grant credits regardless of plan — Dodo has already taken the money. The only correct gate is before a checkout is created.
- Both production deploy jobs are gated on `github.ref == 'refs/heads/master'`. Nothing deploys to prod from `dev`.
- The editor is not touched by this work.
- Live Dodo top-up products must be NAMED for the credits they actually grant ("Arcane 1,600 Credits", "Arcane 7,500 Credits"). Internal ids (`topup_1000`, `DODO_PRODUCT_TOPUP_1000`) stay as-is.
- Commit after every task. Push to `dev` only where a task says so — pushing `arcane-server/**` or `landing-page/**` to `dev` triggers an automatic dev deploy.

---

### Task 1: Server — paid-plan predicate and the top-up checkout gate

**Files:**
- Modify: `arcane-server/src/config/tiers.ts` (add `isPaidPlan`)
- Modify: `arcane-server/src/routes/billing.ts:28-77` (restructure the checkout handler)
- Test: create `arcane-server/test/billing-checkout.test.ts`
- Test: modify `arcane-server/test/tiers.test.ts` (unit-test `isPaidPlan`)

**Interfaces:**
- Consumes: `TIERS`, `TierId`, `isTierId`, `TOPUP_PACKS` from `../src/config/tiers.ts`; `seedPasswordUser`, `tokenFor`, `jsonPost` from `./helpers.ts`; `grantPlanCredits(db, userId, plan, grantMicro, periodEnd)` from `../src/lib/db.ts`.
- Produces: `isPaidPlan(planId: string): boolean` exported from `src/config/tiers.ts`. Response contract for a blocked top-up: HTTP `403`, body `{ error: string, code: 'plan_required' }`. Task 2 consumes that `code` string verbatim.

**Why the gate goes BEFORE the `DODO_API_KEY` guard:** it is an authorization decision about the request itself, independent of whether the payment provider is configured — a free user asking to buy credits deserves "your plan can't do that" whether or not Dodo is wired up. It also makes the gate testable in the existing harness with no network mocking: in tests `DODO_API_KEY` is unset, so a request that *passes* the gate returns `503 billing_unconfigured` while a *blocked* one returns `403 plan_required`. The two statuses cleanly distinguish the outcomes.

**Honest limitation:** those tests prove the gate, not that a real checkout succeeds for a paid user. That is proven empirically in Task 3 against Dodo test mode.

- [ ] **Step 1: Write the failing route tests**

Create `arcane-server/test/billing-checkout.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { seedPasswordUser, tokenFor, jsonPost } from './helpers.ts';
import { grantPlanCredits } from '../src/lib/db.ts';
import { tierGrantMicro, TOPUP_PACKS } from '../src/config/tiers.ts';
import type { UserRow } from '../src/lib/db.ts';

const PACK = TOPUP_PACKS[0]!.id;

async function checkout(user: UserRow, body: { tier?: string; pack?: string }): Promise<Response> {
    return jsonPost('/v1/billing/checkout', body, await tokenFor(user));
}

async function body(res: Response): Promise<{ error?: string; code?: string }> {
    return res.json();
}

describe('top-up checkout is gated on a paid plan', () => {
    it('blocks a free-plan user with 403 plan_required', async () => {
        const u = await seedPasswordUser('gate-free@test.dev', 'password123');
        const res = await checkout(u, { pack: PACK });
        expect(res.status).toBe(403);
        expect((await body(res)).code).toBe('plan_required');
    });

    it('lets a paid-plan user past the gate', async () => {
        const u = await seedPasswordUser('gate-pro@test.dev', 'password123');
        await grantPlanCredits(env.arcane_db, u.id, 'pro', tierGrantMicro('pro'), null);
        const res = await checkout(u, { pack: PACK });
        // Past the gate; DODO_API_KEY is unset in the test env, so the next
        // guard answers. 503 here is the proof the 403 did NOT fire.
        expect(res.status).toBe(503);
        expect((await body(res)).code).toBe('billing_unconfigured');
    });

    it('blocks a user whose plan reverted to free after cancellation', async () => {
        const u = await seedPasswordUser('gate-cancelled@test.dev', 'password123');
        await grantPlanCredits(env.arcane_db, u.id, 'pro', tierGrantMicro('pro'), null);
        await grantPlanCredits(env.arcane_db, u.id, 'free', tierGrantMicro('free'), null);
        const res = await checkout(u, { pack: PACK });
        expect(res.status).toBe(403);
        expect((await body(res)).code).toBe('plan_required');
    });

    it('fails closed on an unrecognised plan value', async () => {
        const u = await seedPasswordUser('gate-unknown@test.dev', 'password123');
        await env.arcane_db.prepare('UPDATE users SET plan = ? WHERE id = ?').bind('enterprise', u.id).run();
        const res = await checkout(u, { pack: PACK });
        expect(res.status).toBe(403);
        expect((await body(res)).code).toBe('plan_required');
    });

    it('reads the plan from the database, not the token', async () => {
        // Token is minted from the pre-upgrade row; the DB says pro. The gate
        // must honour the DB. (AuthPayload carries no plan claim at all — this
        // test locks in that no one adds one as a shortcut.)
        const u = await seedPasswordUser('gate-dbauth@test.dev', 'password123');
        const staleToken = await tokenFor(u);
        await grantPlanCredits(env.arcane_db, u.id, 'pro', tierGrantMicro('pro'), null);
        const res = await jsonPost('/v1/billing/checkout', { pack: PACK }, staleToken);
        expect(res.status).toBe(503);
    });
});

describe('subscription checkout stays open to free users', () => {
    it('does not block a free user upgrading to a paid tier', async () => {
        const u = await seedPasswordUser('gate-upgrade@test.dev', 'password123');
        const res = await checkout(u, { tier: 'pro' });
        // Reaches the unconfigured-billing guard, i.e. was NOT plan-gated.
        expect(res.status).toBe(503);
        expect((await body(res)).code).toBe('billing_unconfigured');
    });

    it('still rejects a bogus tier with 400', async () => {
        const u = await seedPasswordUser('gate-badtier@test.dev', 'password123');
        const res = await checkout(u, { tier: 'platinum' });
        expect(res.status).toBe(400);
    });

    it('still rejects a bogus pack with 400 before any plan check', async () => {
        const u = await seedPasswordUser('gate-badpack@test.dev', 'password123');
        const res = await checkout(u, { pack: 'topup_9999' });
        expect(res.status).toBe(400);
    });
});
```

- [ ] **Step 2: Write the failing predicate test**

Append to `arcane-server/test/tiers.test.ts` (and add `isPaidPlan` to the existing import block from `../src/config/tiers.ts`):

```typescript
describe('isPaidPlan', () => {
    it('is true only for known tiers that cost money', () => {
        expect(isPaidPlan('pro')).toBe(true);
        expect(isPaidPlan('proplus')).toBe(true);
        expect(isPaidPlan('ultra')).toBe(true);
        expect(isPaidPlan('free')).toBe(false);
    });

    it('fails closed on unknown plan values', () => {
        expect(isPaidPlan('enterprise')).toBe(false);
        expect(isPaidPlan('')).toBe(false);
    });

    it('agrees with the tier table rather than a hardcoded list', () => {
        for (const tier of Object.values(TIERS)) {
            expect(isPaidPlan(tier.id)).toBe(tier.priceUsd > 0);
        }
    });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd arcane-server && npm test -- billing-checkout tiers`
Expected: FAIL — `tiers.test.ts` errors on the missing `isPaidPlan` export; `billing-checkout.test.ts` returns 503 where 403 is expected.

- [ ] **Step 4: Add `isPaidPlan` to the tier config**

In `arcane-server/src/config/tiers.ts`, directly below the existing `isTierId` function:

```typescript
/** True only for a KNOWN tier that costs money. An unrecognised plan value
 *  returns false — an allowlist, so a future tier id, a typo, or a corrupted
 *  row can never accidentally open a purchase path. */
export function isPaidPlan(planId: string): boolean {
    const tier = TIERS[planId as TierId];
    return tier !== undefined && tier.priceUsd > 0;
}
```

- [ ] **Step 5: Restructure the checkout handler**

In `arcane-server/src/routes/billing.ts`, add `isPaidPlan` to the existing import from `../config/tiers.ts`, then replace the whole `billingRouter.post('/v1/billing/checkout', ...)` handler with:

```typescript
// Start a checkout for a subscription tier or a one-time top-up pack.
billingRouter.post('/v1/billing/checkout', authMiddleware(), requireVerifiedEmail(), async (c) => {
    const user = c.get('user') as AuthPayload;
    const body = await c.req.json<{ tier?: string; pack?: string }>().catch(() => ({} as { tier?: string; pack?: string }));

    let varName: string | undefined;
    let kind: 'subscription' | 'topup';
    let ref: string;
    let isSubscription: boolean;

    if (body.tier) {
        if (body.tier === 'free' || !isTierId(body.tier)) {
            return c.json({ error: 'Unknown tier', code: 'bad_request' }, 400);
        }
        const tier: Tier = TIERS[body.tier as TierId];
        varName = tier.dodoProductVar; kind = 'subscription'; ref = tier.id; isSubscription = true;
    } else if (body.pack) {
        const pack = TOPUP_PACKS.find(p => p.id === body.pack);
        if (!pack) return c.json({ error: 'Unknown pack', code: 'bad_request' }, 400);
        varName = pack.dodoProductVar; kind = 'topup'; ref = pack.id; isSubscription = false;
    } else {
        return c.json({ error: 'A tier or pack is required', code: 'bad_request' }, 400);
    }

    const full = await findUserById(c.env.arcane_db, parseInt(user.sub));

    // Top-ups are a paid-plan feature. Checked BEFORE the provider-config
    // guards because it is a fact about the request, not about Dodo. The DB
    // row is the authority — the JWT carries no plan claim, and none should be
    // added. Subscription checkout is deliberately NOT gated: that is the
    // upgrade path itself.
    if (kind === 'topup' && !isPaidPlan(full?.plan ?? 'free')) {
        return c.json({
            error: 'Extra credits are available on paid plans. Upgrade your plan to buy credits.',
            code: 'plan_required',
        }, 403);
    }

    if (!c.env.DODO_API_KEY) {
        return c.json({ error: 'Billing is not available yet.', code: 'billing_unconfigured' }, 503);
    }

    const product = productId(c.env, varName);
    if (!product) {
        return c.json({ error: 'This plan is not available yet.', code: 'product_unconfigured' }, 503);
    }

    try {
        const result = await createDodoCheckout({
            apiKey: c.env.DODO_API_KEY,
            apiBase: dodoApiBase(c.env.ENVIRONMENT),
            productId: product,
            isSubscription,
            returnUrl: `${c.env.WEB_BASE_URL}/account?checkout=success`,
            metadata: { arcane_user_id: user.sub, arcane_kind: kind, arcane_ref: ref },
            customerEmail: user.email,
            dodoCustomerId: full?.dodo_customer_id ?? undefined,
        });
        return c.json({ checkoutUrl: result.checkoutUrl });
    } catch (err) {
        console.error('checkout_failed', err instanceof Error ? err.message : String(err));
        return c.json({ error: 'Could not start checkout. Try again.', code: 'checkout_failed' }, 502);
    }
});
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd arcane-server && npm test`
Expected: PASS — the full suite, including the 8 new checkout tests and the 3 new `isPaidPlan` tests. No previously-passing test may regress.

- [ ] **Step 7: Typecheck**

Run: `cd arcane-server && npm run check:types`
Expected: clean, no output.

- [ ] **Step 8: Commit**

```bash
git add arcane-server/src/config/tiers.ts arcane-server/src/routes/billing.ts arcane-server/test/billing-checkout.test.ts arcane-server/test/tiers.test.ts
git commit -m "feat(billing): top-up checkout requires a paid plan"
```

---

### Task 2: Website — locked top-up cards for free users

**Files:**
- Modify: `landing-page/src/lib/billing.ts` (add `canBuyTopups`)
- Create: `landing-page/src/lib/billing.test.ts`
- Modify: `landing-page/src/components/billing/BillingPanel.tsx` (locked cards + `plan_required` handling)

**Interfaces:**
- Consumes: `403 { code: 'plan_required' }` from Task 1; the existing `PlanTier` interface (`{ id, name, priceUsd, monthlyCredits, order }`) and `BillingError` (carries `.status` and `.code`) from `@/lib/billing`.
- Produces: `canBuyTopups(plan: string, tiers: PlanTier[]): boolean`.

**Design refinement over the spec:** the predicate takes the tier ladder the component already fetched from `/v1/billing/plans` and tests `priceUsd > 0`, instead of hardcoding `["pro","proplus","ultra"]` on the client. The server stays the single source of truth, a future paid tier needs no client change, and an empty `tiers` array (the API call failed) yields `false` — failing closed, exactly like the server's allowlist.

**A real defect this task must fix:** `handleCheckoutError` currently treats *any* 403 as an expired session — it calls `clearStoredToken()` and redirects to `/auth`. Without a fix, the new `plan_required` 403 would **sign the user out** instead of explaining anything. The `plan_required` branch must come BEFORE the 401/403 branch.

- [ ] **Step 1: Write the failing predicate test**

Create `landing-page/src/lib/billing.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { canBuyTopups, type PlanTier } from "./billing";

const TIERS: PlanTier[] = [
    { id: "free", name: "Free", priceUsd: 0, monthlyCredits: 150, order: 0 },
    { id: "pro", name: "Pro", priceUsd: 20, monthlyCredits: 2000, order: 1 },
    { id: "proplus", name: "Pro+", priceUsd: 50, monthlyCredits: 5000, order: 2 },
    { id: "ultra", name: "Ultra", priceUsd: 200, monthlyCredits: 20000, order: 3 },
];

describe("canBuyTopups", () => {
    it("is false on the free plan", () => {
        expect(canBuyTopups("free", TIERS)).toBe(false);
    });

    it("is true on every paid plan", () => {
        expect(canBuyTopups("pro", TIERS)).toBe(true);
        expect(canBuyTopups("proplus", TIERS)).toBe(true);
        expect(canBuyTopups("ultra", TIERS)).toBe(true);
    });

    it("fails closed on an unknown plan", () => {
        expect(canBuyTopups("enterprise", TIERS)).toBe(false);
        expect(canBuyTopups("", TIERS)).toBe(false);
    });

    it("fails closed when the tier ladder could not be loaded", () => {
        expect(canBuyTopups("pro", [])).toBe(false);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd landing-page && pnpm test -- billing`
Expected: FAIL — `canBuyTopups` is not exported from `./billing`.

- [ ] **Step 3: Add the predicate**

In `landing-page/src/lib/billing.ts`, directly below the `PlansResponse` interface:

```typescript
/** Top-ups are a paid-plan feature (server gate: `plan_required`, 403).
 *  Derived from the tier ladder the server serves rather than a hardcoded
 *  list, so `arcane-server/src/config/tiers.ts` stays the single source of
 *  truth. An unknown plan — or an empty ladder because /plans failed — is
 *  false, matching the server's allowlist and failing closed. */
export function canBuyTopups(plan: string, tiers: PlanTier[]): boolean {
    const tier = tiers.find(t => t.id === plan);
    return tier !== undefined && tier.priceUsd > 0;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd landing-page && pnpm test -- billing`
Expected: PASS, 4 tests.

- [ ] **Step 5: Fix the sign-out defect in the error handler**

In `landing-page/src/components/billing/BillingPanel.tsx`, replace `handleCheckoutError` with:

```tsx
    const handleCheckoutError = (err: unknown) => {
        if (err instanceof BillingError && (err.code === "billing_unconfigured" || err.code === "product_unconfigured")) {
            setNotice({ msg: "Billing is launching soon — check back shortly.", type: "info" });
        } else if (err instanceof BillingError && err.code === "plan_required") {
            // A 403 that is NOT an auth failure — must be handled before the
            // 401/403 branch below, which signs the user out.
            setNotice({ msg: err.message, type: "info" });
        } else if (err instanceof BillingError && (err.status === 401 || err.status === 403)) {
            clearStoredToken();
            window.location.href = "/auth?return=/account";
        } else {
            setNotice({ msg: err instanceof Error ? err.message : "Something went wrong.", type: "error" });
        }
    };
```

- [ ] **Step 6: Render the top-up cards locked on the free plan**

In the same file, add `canBuyTopups` to the existing import from `@/lib/billing`. Then, next to the existing `const isFree = usage.plan === "free";` line, add:

```tsx
    const canBuy = canBuyTopups(usage.plan, tiers);
```

Replace the entire `{topups.length > 0 && ( ... )}` block at the end of the component with:

```tsx
            {topups.length > 0 && (
                <div className="glass rounded-2xl p-6">
                    <h2 className="font-display text-lg font-bold mb-1">Buy extra credits</h2>
                    <p className="text-muted-foreground text-sm mb-4">
                        {canBuy
                            ? "One-time top-ups that never expire — used after your plan credits run out."
                            : "One-time top-ups that never expire. Available on paid plans."}
                    </p>
                    <div className="flex flex-wrap gap-3">
                        {topups.map(p => (
                            <button
                                key={p.id}
                                onClick={() => buyTopup(p.id)}
                                disabled={!canBuy || busy === p.id}
                                title={canBuy ? undefined : "Upgrade to a paid plan to buy credits"}
                                className={`flex-1 min-w-[150px] glass rounded-xl p-4 text-left transition-all disabled:opacity-50 ${canBuy ? "hover:border-primary/40" : "cursor-not-allowed"}`}
                            >
                                <div className="font-mono text-base font-bold text-foreground">{p.credits.toLocaleString()} credits</div>
                                <div className="text-sm text-primary font-semibold mt-1">{busy === p.id ? "Starting…" : `$${p.priceUsd}`}</div>
                            </button>
                        ))}
                    </div>
                    {!canBuy && (
                        <a
                            href="/pricing"
                            className="inline-block mt-4 h-10 leading-10 rounded-md px-4 bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all"
                        >
                            Upgrade to buy credits
                        </a>
                    )}
                </div>
            )}
```

- [ ] **Step 7: Typecheck, test, and build**

Run: `cd landing-page && pnpm exec astro sync && pnpm exec tsc --noEmit && pnpm test && pnpm build`
Expected: typecheck clean, all tests pass, build green.

- [ ] **Step 8: Commit**

```bash
git add landing-page/src/lib/billing.ts landing-page/src/lib/billing.test.ts landing-page/src/components/billing/BillingPanel.tsx
git commit -m "feat(billing): lock top-up cards on the free plan"
```

---

### Task 3: Full green-build gate, then prove billing end-to-end in Dodo test mode

**Files:** none modified unless a defect is found (see Step 7).

**Interfaces:**
- Consumes: Tasks 1 and 2, deployed to the dev stack.
- Produces: a confirmed list of the ACTUAL Dodo webhook event type strings, to be checked against the `switch` in `arcane-server/src/routes/billing-webhook.ts:70-140`.

**Why this task exists:** the billing path has never been exercised against a real Dodo checkout. The API request/response shapes were verified against the reference (`POST /checkouts` → `{session_id, checkout_url}`; `POST /customers/{id}/customer-portal/session` → `{link}`) and match `src/lib/dodo.ts`. The event NAMES were not verifiable from the reference. A real test-mode purchase settles them for free. Discovering a mismatch here costs nothing; discovering it after a live charge means a paying customer received no credits.

Dev already has everything needed: test products, `DODO_API_KEY`, `DODO_WEBHOOK_SECRET`, and a registered webhook endpoint `ep_3HizO4n2sOp4JKd4F9Wd7KX5qsU` → `https://api-dev.arcaneai.org/v1/billing/webhook` with no event filter.

- [ ] **Step 1: Run every suite green**

```bash
cd arcane-server && npm run check:types && npm test
cd ../editor && bunx tsc --noEmit && bun test src
cd ../landing-page && pnpm exec astro sync && pnpm exec tsc --noEmit && pnpm test && pnpm build
```
Expected: all green. Record the server and editor test counts in the run notes — a drop from a prior run is a regression, not noise.

- [ ] **Step 2: Push to `dev` and let CI deploy**

```bash
git push origin dev
gh run watch
```
Expected: `Deploy Server` and `Deploy Landing` both succeed (the push touches `arcane-server/**` and `landing-page/**`).

- [ ] **Step 3: Confirm the dev stack is serving the new code**

```bash
curl -s https://api-dev.arcaneai.org/v1/billing/plans | head -c 400
```
Expected: JSON with 4 tiers and 2 top-up packs.

- [ ] **Step 4: Start a tail before purchasing**

```bash
cd arcane-server && npx wrangler tail --env dev --format pretty
```
Leave running. Every webhook the worker receives is logged here.

- [ ] **Step 5: Buy Pro in Dodo test mode**

In a browser: sign in at `https://dev.arcaneai.org/auth` → `/pricing` → **Choose Pro** → the Dodo test checkout opens. Pay with the test PAN `4242 4242 4242 4242`, any future expiry, any CVC. (If that card is rejected, the accepted test cards are listed in the Dodo dashboard's test-mode panel.) Expect a redirect back to `/account?checkout=success`.

- [ ] **Step 6: Read the ACTUAL event names out of the tail**

In the tail output, find the webhook POSTs. Write down every `type` value observed. Compare against what `billing-webhook.ts` handles:

| Handled by the switch | Observed? |
|---|---|
| `subscription.active` | |
| `subscription.renewed` | |
| `subscription.on_hold` | |
| `subscription.cancelled` | |
| `subscription.failed` | |
| `payment.succeeded` | |
| `payment.failed` | |

A log line reading `billing_event_unhandled` naming a type we expected to handle IS the mismatch this task exists to catch.

- [ ] **Step 7: If (and only if) an event name differs, fix it**

Update the `switch` in `arcane-server/src/routes/billing-webhook.ts` to the observed names, add a case to `arcane-server/test/billing-webhook.test.ts` asserting the corrected name grants the plan, run `npm test`, commit, push, and re-verify. Do not proceed to Task 4 with a known mismatch.

- [ ] **Step 8: Confirm the grant landed**

```bash
cd arcane-server && npx wrangler d1 execute arcane-db-dev --env dev --remote \
  --command "SELECT id, email, plan, plan_credits_micro, topup_credits_micro, plan_period_end FROM users ORDER BY id DESC LIMIT 5"
```
Expected: the purchasing user shows `plan = 'pro'` and `plan_credits_micro = 20000000` (2,000 credits × 10,000 micro).

- [ ] **Step 9: Prove the free-plan gate on a live stack**

To get a bearer token for the `curl` checks below (and in Tasks 5 and 6): sign
in in the browser, open DevTools → Console, and run
`localStorage.getItem('arcane_auth_token')`. Export it in the shell as
`FREE_USER_TOKEN` (or `PROD_TOKEN` later). Tokens are short-lived — re-read it
if a call returns 401.

Sign in as a SECOND, free-plan account on `dev.arcaneai.org`, open `/account`, and confirm: the top-up cards render disabled, the "Upgrade to buy credits" link is present, and clicking a locked card does nothing. Then hit the API directly with that account's token:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://api-dev.arcaneai.org/v1/billing/checkout \
  -H "Authorization: Bearer $FREE_USER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"pack":"topup_1000"}'
```
Expected: `403`. Confirm the browser session was NOT signed out — that is the `handleCheckoutError` fix from Task 2 doing its job.

- [ ] **Step 10: Buy a top-up on the Pro account**

As the Pro user, `/account` → buy the 1,600-credit pack in test mode. Expected: `payment.succeeded` in the tail, and `topup_credits_micro = 16000000` on that row.

- [ ] **Step 11: Cancel and confirm the downgrade**

As the Pro user, `/account` → **Manage subscription** → cancel in the Dodo portal. Expected: a `subscription.cancelled` event, the row flips to `plan = 'free'` with `plan_credits_micro` at the free grant (1,500,000), and `topup_credits_micro` UNCHANGED — top-up credits were paid for and survive a downgrade.

- [ ] **Step 12: Record the findings**

Append the observed event names and each verification result to `docs/superpowers/plans/2026-07-20-billing-manual-verification.md` under a new `## Test-mode e2e — VERIFIED 2026-08-18` heading, then commit.

```bash
git add docs/superpowers/plans/2026-07-20-billing-manual-verification.md
git commit -m "docs: record the test-mode billing e2e results"
```

---

### Task 4: Migration rehearsal and merge to `master`

**Files:**
- Modify: none in the repo; produces a throwaway local D1 and a merge commit.

**Interfaces:**
- Consumes: a green `dev` from Task 3.
- Produces: `master` containing all of `dev`, with CI green — the precondition both prod deploy jobs check (`github.ref == 'refs/heads/master'`).

**Why rehearse:** prod D1 has 10 unapplied migrations (`0012`–`0021`). `0013_billing.sql` uses `ADD COLUMN`, which is not idempotent — a partial failure leaves the schema half-migrated and needs manual reconciliation. Rehearsing against an exact copy of the prod data costs one command and removes that risk.

- [ ] **Step 1: Export the live prod database**

```bash
cd arcane-server
npx wrangler d1 export arcane-db --remote --output /tmp/prod-snapshot.sql
wc -l /tmp/prod-snapshot.sql
```
Expected: a non-trivial file containing `CREATE TABLE` statements and the `d1_migrations` rows for `0001`–`0011`.

- [ ] **Step 2: Load the snapshot into a fresh local D1**

NOTE: this wipes local D1 dev state, which is ephemeral scratch data.

```bash
rm -rf .wrangler/state/v3/d1
npx wrangler d1 execute arcane-db --local --file=/tmp/prod-snapshot.sql
npx wrangler d1 execute arcane-db --local --command "SELECT COUNT(*) AS users FROM users"
```
Expected: `users = 9`, matching prod.

- [ ] **Step 3: Apply the 10 pending migrations against the copy**

```bash
npx wrangler d1 migrations apply arcane-db --local
```

**RESULT (2026-08-18): THIS FAILED, and the rehearsal earned its keep.**
`0012` applied, then `0013_billing.sql` died with `duplicate column name: plan`,
leaving the replica half-migrated. Root cause: prod's `users` table still
carries `plan`, `promo_code`, `promo_expires_at`, and `credits_reset_at`, and
the `plans` and `upgrade_requests` tables still exist — i.e.
`0008_remove_plans_credits.sql` is recorded as applied in prod's
`d1_migrations` but **none of its statements ever took effect** (most likely the
D1 SQLite version at the time did not support `ALTER TABLE ... DROP COLUMN`).
The dev database was provisioned after that point, so 0008 applied there for
real and the divergence never surfaced.

Fix: `arcane-server/scripts/prod-reconcile-0008.sql` replays 0008's body so the
schema matches what the migration history already claims. Run it against the
target database IMMEDIATELY BEFORE `migrations apply`:

```bash
npx wrangler d1 execute arcane-db --local --file=scripts/prod-reconcile-0008.sql
npx wrangler d1 migrations apply arcane-db --local
```
Expected (verified 2026-08-18): the reconciliation reports `6 commands executed
successfully`, then `0012`–`0021` all apply ✅ and `migrations list` reports
`No migrations to apply!`.

It is deliberately NOT a numbered migration: `d1_migrations` already lists 0008
as applied, and a new number would run after 0013 — too late to help.

- [ ] **Step 4: Confirm the existing users survived with sane billing defaults**

```bash
npx wrangler d1 execute arcane-db --local \
  --command "SELECT id, email, plan, plan_credits_micro, topup_credits_micro, plan_period_end, email_verified FROM users ORDER BY id"
```
Expected: all 9 rows present, every `plan = 'free'`, `topup_credits_micro = 0`, and no NULLs in `plan` or `plan_credits_micro`. A NULL `plan` would break `isPaidPlan` and the credit gate — if one appears, add a migration that backfills it before prod.

**RESULT (2026-08-18): PASS.** All 9 users present, each `plan='free'`,
`plan_credits_micro=1500000` (0013's grandfather grant of 150 credits),
`topup_credits_micro=0`, `plan_period_end=NULL`, no NULLs anywhere. Legacy
tables `plans`/`upgrade_requests` gone; `subscriptions`, `billing_events`,
`usage_periods`, `request_logs` all present; `dodo_customer_id` resolves.

**One value is intentionally discarded by the reconciliation:** user id 5
(`sourav.das@masaischool.com`) had legacy `plan='pro'` from the removed
pre-0008 credits system. `DROP COLUMN plan` discards it and 0013 re-creates the
column defaulting to `'free'`. That account has no Dodo subscription backing it,
so `'free'` is the correct new-system state — but Task 5 restores it anyway so
nobody is silently downgraded. Capture the legacy values BEFORE reconciling.

- [ ] **Step 5: Verify the schema the new code expects is actually there**

```bash
npx wrangler d1 execute arcane-db --local --command "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('subscriptions','billing_events','usage_periods','request_logs')"
npx wrangler d1 execute arcane-db --local --command "SELECT dodo_customer_id FROM users LIMIT 1"
```
Expected: all four tables listed, and the `dodo_customer_id` column resolves (proving `0013`'s `ADD COLUMN` applied).

- [ ] **Step 6: Merge `dev` into `master`**

`dev` already contains every commit on `master` (verified: `git rev-list --count dev..master` = 0), so this is a clean fast-forward and `--ff-only` asserts that.

```bash
cd /Users/inno/Documents/experiments/arcane-editor
git checkout master
git merge --ff-only dev
git push origin master
```

- [ ] **Step 7: Confirm CI is green on `master`**

```bash
gh run watch
```
Expected: the `CI` workflow passes on `master`. Do not start Task 5 until it does.

---

### Task 5: Window 1 — production cutover with billing dark

**Files:**
- Modify: none. This task deploys existing code and sets secrets.

**Interfaces:**
- Consumes: green `master` from Task 4.
- Produces: a live prod stack serving auth + AI, with `POST /v1/billing/checkout` returning `503 billing_unconfigured`.

**Owner action required in Step 2** — everything else is automated.

Billing being dark is not a special build: with `DODO_API_KEY` unset, checkout and portal return 503 by design, and the webhook returns 503 rather than trusting an unsigned payload.

- [ ] **Step 1: Record the restore point BEFORE migrating**

```bash
cd arcane-server && npx wrangler d1 time-travel info arcane-db
```
Write the reported bookmark down in the run notes. This is the only rollback for a failed migration; do not skip it.

- [ ] **Step 2: OWNER — register the production GitHub OAuth App**

GitHub allows one callback URL per OAuth App, so prod needs its own, separate from dev's. At <https://github.com/settings/developers> → **New OAuth App**:
- Application name: `Arcane`
- Homepage URL: `https://arcaneai.org`
- Authorization callback URL: `https://api.arcaneai.org/v1/auth/github/callback`

Then hand over the Client ID and a generated Client Secret. (`gh` cannot create OAuth Apps — this step is unavoidably manual.)

- [ ] **Step 3: Set the GitHub secrets on the prod worker**

```bash
cd arcane-server
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret list
```
Expected: the list shows `JWT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`. `DODO_*` must still be ABSENT — that is what keeps billing dark.

- [ ] **Step 3b: Capture legacy paid plans, then reconcile the prod schema**

`deploy-server.yml` runs `d1 migrations apply` as its first step, and on prod
that WILL fail at `0013_billing.sql` unless the schema is reconciled first (see
Task 4 Step 3). Do this before dispatching the workflow.

```bash
cd arcane-server
# 1. Capture what the reconciliation is about to discard — keep this output.
npx wrangler d1 execute arcane-db --remote \
  --command "SELECT id, email, plan FROM users WHERE plan <> 'free'"
# 2. Replay 0008's body so the schema matches the recorded migration history.
npx wrangler d1 execute arcane-db --remote --file=scripts/prod-reconcile-0008.sql
```
Expected: step 1 returns exactly one row (id 5, `sourav.das@masaischool.com`,
`pro`) — record it for Step 6b. Step 2 reports `6 commands executed
successfully`. If step 1 returns rows you did not expect, STOP and reassess:
every non-free legacy plan must be restored in Step 6b.

- [ ] **Step 4: Deploy the worker (migrations run first)**

```bash
gh workflow run deploy-server.yml -f environment=production --ref master
gh run watch
```
Expected: the `deploy-prod` job applies `0012`–`0021` to `arcane-db` and then deploys. Migrations run BEFORE the deploy so new code never sees an old schema. If migrations fail, stop and restore via `npx wrangler d1 time-travel restore arcane-db --bookmark <bookmark from Step 1>`. If migrations succeed but the deployed worker misbehaves, roll the code back with `npx wrangler rollback` (the schema is forward-compatible with the old code for these migrations — they only add tables and columns).

- [ ] **Step 5: Deploy the website**

```bash
gh workflow run deploy-landing.yml -f environment=production --ref master
gh run watch
```
Expected: typecheck, tests, and a build with `PUBLIC_API_URL=https://api.arcaneai.org`, published to the `arcane-landing` Pages project.

- [ ] **Step 6: Verify the prod surface is live**

```bash
for p in /health /v1/billing/plans; do printf '%s -> ' "$p"; curl -s -o /dev/null -w "%{http_code}\n" "https://api.arcaneai.org$p"; done
for p in /pricing /auth /account; do printf '%s -> ' "$p"; curl -s -o /dev/null -w "%{http_code}\n" "https://arcaneai.org$p"; done
```
Expected: every one returns `200` (they were `404` before this task).

- [ ] **Step 6b: Restore the legacy paid plan discarded by the reconciliation**

For every row captured in Step 3b, restore the plan and its monthly grant so the
account is not silently downgraded. For the expected single row (id 5, `pro`,
grant = 2,000 credits × 10,000 micro):

```bash
cd arcane-server
npx wrangler d1 execute arcane-db --remote \
  --command "UPDATE users SET plan = 'pro', plan_credits_micro = 20000000 WHERE id = 5"
npx wrangler d1 execute arcane-db --remote \
  --command "SELECT id, email, plan, plan_credits_micro FROM users WHERE id = 5"
```
Expected: `plan='pro'`, `plan_credits_micro=20000000`. Note this account has no
Dodo subscription, so nothing will renew it — it is a grandfathered grant, not a
billing relationship, and `subscription.*` webhooks will never touch it.

- [ ] **Step 7: Verify billing is safely closed**

Sign up a fresh account on `https://arcaneai.org/auth` with a real email address, complete the OTP, then:

```bash
curl -s -X POST https://api.arcaneai.org/v1/billing/checkout \
  -H "Authorization: Bearer $PROD_TOKEN" -H 'Content-Type: application/json' \
  -d '{"tier":"pro"}'
```
Expected: `{"error":"Billing is not available yet.","code":"billing_unconfigured"}` with status 503. This is the proof that no money can move yet.

- [ ] **Step 8: Verify auth and AI on prod**

Confirm, in order: (a) the signup OTP email arrived; (b) GitHub sign-in completes and lands back signed in; (c) `/account` shows **Free** with 150 credits; (d) signing into the Arcane app against prod and running a chat streams a reply; (e) usage is metered:

```bash
cd arcane-server && npx wrangler d1 execute arcane-db --remote \
  --command "SELECT COUNT(*) AS logs FROM request_logs WHERE created_at > datetime('now','-1 hour')"
```
Expected: at least one row from the chat in (d).

- [ ] **Step 9: Record the window-1 result**

Note in the run log: the bookmark from Step 1, the deploy run URLs, and each verification outcome. Stop here if anything above failed — Task 6 introduces real money and must not start on a shaky stack.

---

### Task 6: Window 2 — live Dodo provisioning and the real-money proof

**Files:**
- Modify: `arcane-server/wrangler.toml` (the five prod `DODO_PRODUCT_*` vars)

**Interfaces:**
- Consumes: a verified prod stack from Task 5; a live-mode Dodo API key.
- Produces: five live product ids, a live webhook endpoint id and signing secret, and a production stack accepting real payments.

**Owner actions:** supply the live API key (Step 1) and make the real purchase (Step 7).

- [ ] **Step 1: OWNER — point the Dodo MCP at a live-mode API key**

The MCP is currently authenticated against `https://test.dodopayments.com`. Reconnect it with a live-mode key so `client.baseURL` becomes `https://live.dodopayments.com`. The same key is also the value of the `DODO_API_KEY` worker secret in Step 4 — one key, set in two places.

- [ ] **Step 2: Create the five live products**

The request body below was checked against the SDK reference for
`client.products.create` (`POST /products`): `price` is a discriminated union
requiring `currency`/`discount`/`price`/`purchasing_power_parity`/`type`, plus
the four `payment_frequency_*`/`subscription_period_*` fields for
`recurring_price`; `tax_category` is a required top-level field; the response
carries `product_id`.

Confirm live mode first, then create. Prices are read from `src/config/tiers.ts` (Pro $20, Pro+ $50, Ultra $200, top-ups $16 and $75) and must not be retyped from memory. Amounts are in cents. Top-up names state the credits actually granted — 1,600 and 7,500 — NOT the legacy `1000`/`5000` in the internal ids.

```typescript
async function run(client) {
  if (!client.baseURL.includes('live.dodopayments.com')) {
    throw new Error(`Refusing to create products: client is on ${client.baseURL}, expected live`);
  }
  const specs = [
    { name: 'Arcane Pro',           cents: 2000,  recurring: true },
    { name: 'Arcane Pro+',          cents: 5000,  recurring: true },
    { name: 'Arcane Ultra',         cents: 20000, recurring: true },
    { name: 'Arcane 1,600 Credits', cents: 1600,  recurring: false },
    { name: 'Arcane 7,500 Credits', cents: 7500,  recurring: false },
  ];
  const created = [];
  for (const s of specs) {
    const price = s.recurring
      ? { type: 'recurring_price', price: s.cents, currency: 'USD', discount: 0, purchasing_power_parity: false,
          payment_frequency_count: 1, payment_frequency_interval: 'Month',
          subscription_period_count: 1, subscription_period_interval: 'Month' }
      : { type: 'one_time_price', price: s.cents, currency: 'USD', discount: 0, purchasing_power_parity: false };
    const p = await client.products.create({ name: s.name, price, tax_category: 'saas' });
    created.push({ name: s.name, product_id: p.product_id, price: s.cents, recurring: s.recurring });
  }
  return created;
}
```
Expected: five `pdt_…` ids. Record them — Step 5 writes them into `wrangler.toml`.

- [ ] **Step 3: Create the live webhook endpoint and read its signing secret**

```typescript
async function run(client) {
  if (!client.baseURL.includes('live.dodopayments.com')) {
    throw new Error(`Refusing: client is on ${client.baseURL}, expected live`);
  }
  const hook = await client.webhooks.create({
    url: 'https://api.arcaneai.org/v1/billing/webhook',
    description: 'Arcane prod worker (arcane-server)',
  });
  const { secret } = await client.webhooks.retrieveSecret(hook.id);
  return { id: hook.id, url: hook.url, filter_types: hook.filter_types, secret };
}
```
Expected: an `ep_…` id, `filter_types: null` (all events — matching the dev endpoint), and a `whsec_…` secret. Treat the secret as sensitive: it goes straight into `wrangler secret put` and nowhere else.

- [ ] **Step 4: Set both Dodo secrets on the prod worker**

```bash
cd arcane-server
npx wrangler secret put DODO_API_KEY        # the live key from Step 1
npx wrangler secret put DODO_WEBHOOK_SECRET # the whsec_… from Step 3
npx wrangler secret list
```
Expected: five secrets — `JWT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `DODO_API_KEY`, `DODO_WEBHOOK_SECRET`.

- [ ] **Step 5: Write the live product ids into the prod vars and deploy**

In `arcane-server/wrangler.toml`, replace the five empty prod `[vars]` entries (lines beginning `DODO_PRODUCT_`, the ones ABOVE the `[env.dev.vars]` block — do not touch the dev test-mode ids) with the ids from Step 2:

```toml
DODO_PRODUCT_PRO = "pdt_…"
DODO_PRODUCT_PROPLUS = "pdt_…"
DODO_PRODUCT_ULTRA = "pdt_…"
DODO_PRODUCT_TOPUP_1000 = "pdt_…"   # Arcane 1,600 Credits
DODO_PRODUCT_TOPUP_5000 = "pdt_…"   # Arcane 7,500 Credits
```

```bash
git add arcane-server/wrangler.toml
git commit -m "chore(billing): wire the live Dodo product ids into prod"
git push origin master
gh workflow run deploy-server.yml -f environment=production --ref master
gh run watch
```
Secrets take effect immediately; vars require this deploy.

- [ ] **Step 6: Confirm billing is open**

```bash
curl -s -X POST https://api.arcaneai.org/v1/billing/checkout \
  -H "Authorization: Bearer $PROD_TOKEN" -H 'Content-Type: application/json' \
  -d '{"tier":"pro"}' | head -c 200
```
Expected: `{"checkoutUrl":"https://…"}` — no longer 503. Do not complete this checkout; Step 7 is the deliberate one.

- [ ] **Step 7: OWNER — the real-money proof, in order**

Keep `npx wrangler tail` (prod, no `--env`) running throughout.

1. **Buy Pro with a real card** on `https://arcaneai.org/pricing`. Expect `subscription.active`, `plan = 'pro'`, 2,000 credits, and `/account` showing both.
2. **Confirm the free-plan rule** from a second, free account: `/account` shows locked cards with the upgrade link, `POST /v1/billing/checkout {"pack":"topup_1000"}` returns `403 plan_required`, and the session is NOT signed out.
3. **Buy a top-up** on the Pro account → `payment.succeeded` → 1,600 credits added on top.
4. **Cancel** via **Manage subscription** → `subscription.cancelled` → plan reverts to free, top-up credits preserved.

Verify after each:

```bash
cd arcane-server && npx wrangler d1 execute arcane-db --remote \
  --command "SELECT email, plan, plan_credits_micro, topup_credits_micro FROM users WHERE email = '<buyer email>'"
```

- [ ] **Step 8: If anything misbehaves, use the kill switch**

```bash
cd arcane-server && npx wrangler secret delete DODO_API_KEY
```
Checkout returns 503 again while auth and AI keep serving. The webhook keeps verifying, so any payment already in flight still grants its credits. Diagnose, fix, re-add the secret.

- [ ] **Step 9: Record the window-2 result**

Append the live product ids, the webhook endpoint id, and each proof outcome to `docs/superpowers/plans/2026-07-20-billing-manual-verification.md` under `## Live cutover — 2026-08-18`. Do NOT record the API key or the webhook secret.

```bash
git add docs/superpowers/plans/2026-07-20-billing-manual-verification.md
git commit -m "docs: record the live Dodo cutover results"
git push origin master
```

---

### Task 7: Tag and ship v0.3.0

**Files:**
- Modify: `editor/package.json`, `editor/src-tauri/Cargo.toml`, `editor/src-tauri/tauri.conf.json` (version `0.2.2` → `0.3.0`)

**Interfaces:**
- Consumes: a verified live stack from Task 6.
- Produces: a `v0.3.0` tag and installers in the `arcane-releases` R2 bucket.

- [ ] **Step 1: Bump the version in all three places**

All three must match or the Tauri build fails.

```bash
cd /Users/inno/Documents/experiments/arcane-editor
sed -i '' 's/"version": "0.2.2"/"version": "0.3.0"/' editor/package.json editor/src-tauri/tauri.conf.json
sed -i '' 's/^version = "0.2.2"/version = "0.3.0"/' editor/src-tauri/Cargo.toml
grep -n '"version"' editor/package.json editor/src-tauri/tauri.conf.json | head
grep -n '^version' editor/src-tauri/Cargo.toml
```
Expected: `0.3.0` in all three.

- [ ] **Step 2: Refresh the Cargo lockfile**

```bash
cd editor/src-tauri && cargo check --quiet 2>&1 | tail -5
git diff --stat Cargo.lock
```
Expected: `Cargo.lock` picks up the new version. A stale lockfile fails the release build on CI.

- [ ] **Step 3: Commit and tag**

```bash
cd /Users/inno/Documents/experiments/arcane-editor
git add editor/package.json editor/src-tauri/Cargo.toml editor/src-tauri/tauri.conf.json editor/src-tauri/Cargo.lock
git commit -m "chore(release): v0.3.0 — auth, AI, and live billing in production"
git push origin master
git tag v0.3.0
git push origin v0.3.0
```

- [ ] **Step 4: Watch the release build**

```bash
gh run watch
```
Expected: the `Release` workflow builds macOS arm64 and Windows x64 and uploads to the `arcane-releases` R2 bucket.

- [ ] **Step 5: Verify the installers are downloadable**

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://releases.arcaneai.org/latest/Arcane-arm64.dmg
curl -s -o /dev/null -w "%{http_code}\n" https://releases.arcaneai.org/v0.3.0/Arcane-arm64.dmg
```
Expected: both `200`. These are the exact paths `release.yml` writes (`arcane-releases/latest/…` and `arcane-releases/$V/…`) and the `latest` one is what `landing-page/src/lib/releases.ts` links to.

- [ ] **Step 6: Final end-to-end check on the shipped build**

Install the released build, sign in against prod, run a chat, and confirm the Account tab shows the correct plan and credit balance. This is the same path a new user takes on day one.

- [ ] **Step 7: Update the project memory**

Update `/Users/inno/.claude/projects/-Users-inno-Documents-experiments-arcane-editor/memory/MEMORY.md` and the billing memory file to record that the prod cutover is DONE, listing the live product ids, the live webhook endpoint id, and the remaining owner follow-ups (Google sign-in, Turnstile, refund/dispute handling).
