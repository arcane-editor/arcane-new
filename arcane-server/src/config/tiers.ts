// Subscription tiers, top-up packs, and the credit⇄cost unit conversions —
// the SINGLE source of truth for pricing. Every dollar figure here is
// ILLUSTRATIVE and rate-table-driven: they are tuned once the real Cloudflare
// neuron costs for our models are confirmed (see costs.ts + the plan's Pricing
// model). Changing a price or grant is a one-file edit.
//
// Unit model: internal accounting is in integer MICRO-USD of *estimated model
// cost*. A user-facing "credit" is $0.01 of that cost.

export const CREDIT_USD = 0.01;                 // 1 credit = $0.01 of model cost
export const MICRO_PER_USD = 1_000_000;
export const MICRO_PER_CREDIT = Math.round(CREDIT_USD * MICRO_PER_USD); // 10,000

/** Cloudflare's fee on prepaid AI Gateway credits (5%). Applied to every AI
 *  request because gateway credits fund both Workers AI and third-party spend. */
export const GATEWAY_FEE = 1.05;

/** Legacy multiplier applied at debit time (see usage.ts's billedMicro).
 *  Margin no longer lives here: it lives in the grant sizing below (the
 *  owner's 10% holdback baked into each paid plan's monthly credits) and in
 *  the top-up markup (20%, see TOPUP_PACKS). Kept at 1.0 — a no-op — rather
 *  than removed, so a debit-time lever still exists if ever needed again. */
export const MARGIN = 1.0;

export interface Tier {
    id: string;
    name: string;
    priceUsd: number;
    monthlyCredits: number;
    /** Env var holding this tier's Dodo product id (paid tiers only). */
    dodoProductVar?: string;
    order: number;
}

// Paid grants = floor((priceUsd x (1 - 0.10 - 0.045) - 0.40) x 100) — plan
// price minus the owner's 10% cut minus Dodo's fee (4% card-processing + 0.5%
// subscription surcharge = 4.5%, plus a $0.40 flat base). Free's 150 credits
// are a ONE-TIME signup trial (see SIGNUP_TRIAL_MICRO below), not a monthly
// grant — a free row's plan_period_end stays NULL forever.
// `satisfies` keeps the literal key types so TIERS.free etc. are never
// `undefined` (the codebase runs with noUncheckedIndexedAccess).
export const TIERS = {
    free:    { id: 'free',    name: 'Free',    priceUsd: 0,  monthlyCredits: 150,  order: 0 },
    starter: { id: 'starter', name: 'Starter', priceUsd: 5,  monthlyCredits: 387,  dodoProductVar: 'DODO_PRODUCT_STARTER', order: 1 },
    pro:     { id: 'pro',     name: 'Pro',     priceUsd: 25, monthlyCredits: 2097, dodoProductVar: 'DODO_PRODUCT_PRO',     order: 2 },
    max:     { id: 'max',     name: 'Max',     priceUsd: 50, monthlyCredits: 4235, dodoProductVar: 'DODO_PRODUCT_MAX',     order: 3 },
} satisfies Record<string, Tier>;

export type TierId = keyof typeof TIERS;

/** The free plan's ONE-TIME signup trial (not a monthly grant — see db.ts's
 *  createUser/createOAuthUser, the only places this is granted). */
export const SIGNUP_TRIAL_MICRO = creditsToMicro(TIERS.free.monthlyCredits); // 1_500_000

/** Which effort tiers each plan may request. Deep Think and Max are paid. */
export const ALLOWED_TIERS: Record<TierId, readonly string[]> = {
    free:    ['low'],
    starter: ['low'],
    pro:     ['low', 'mid'],
    max:     ['low', 'mid', 'high'],
};

/** Legacy wire value `super` is an alias of `high`. */
export function isTierAllowed(planId: string, tier: string): boolean {
    const plan = (isTierId(planId) ? planId : 'free') as TierId;
    const normalized = tier === 'super' ? 'high' : tier;
    return ALLOWED_TIERS[plan].includes(normalized);
}

/** Lowest-`order` plan whose ALLOWED_TIERS include this effort tier — the
 *  plan a 403 should point the user at (low→free, mid→pro, high→max). `super`
 *  normalizes to `high` like isTierAllowed. A tier no plan grants falls back
 *  to 'free' rather than pointing at an upgrade that would not help. */
export function minPlanForTier(tier: string): TierId {
    const normalized = tier === 'super' ? 'high' : tier;
    const byOrder = (Object.values(TIERS) as Tier[]).slice().sort((a, b) => a.order - b.order);
    for (const t of byOrder) {
        if (ALLOWED_TIERS[t.id as TierId].includes(normalized)) return t.id as TierId;
    }
    return 'free';
}

/** Monthly inline spend ceiling in micro-USD of REAL cost (no margin — inline
 *  is free to the user). Free is a FEATURE LOCK (0 — see the first check in
 *  checkInlineAllowance), not a quota; paid plans get 10% of plan price, in
 *  real cost. */
export const INLINE_MONTHLY_MICRO_CEILING: Record<TierId, number> = {
    free: 0, starter: 500_000, pro: 2_500_000, max: 5_000_000,
};

/** Daily suggestion caps, derived from the monthly budget / 30 and rounded to
 *  a clean number. These ration the budget across the month; the micro-USD
 *  ceiling above is the hard backstop, because a request count does not bound
 *  cost — cost scales with context size. Free is 0 (feature lock, not a
 *  quota — see checkInlineAllowance). */
export const INLINE_DAILY_CAP: Record<TierId, number> = {
    free: 0, starter: 300, pro: 1500, max: 3000,
};

export interface TopupPack {
    id: string;
    credits: number;
    priceUsd: number;
    dodoProductVar: string;
}

// Top-up credits carry a 20% markup: credits = floor(priceUsd × 100 / 1.2).
export const TOPUP_PACKS: TopupPack[] = [
    { id: 'topup_16', credits: 1333, priceUsd: 16, dodoProductVar: 'DODO_PRODUCT_TOPUP_16' },
    { id: 'topup_75', credits: 6250, priceUsd: 75, dodoProductVar: 'DODO_PRODUCT_TOPUP_75' },
];

export function isTierId(x: string): boolean {
    return Object.prototype.hasOwnProperty.call(TIERS, x);
}

/** True only for a KNOWN tier that costs money. An unrecognised plan value
 *  returns false — an allowlist, so a future tier id, a typo, or a corrupted
 *  row can never accidentally open a purchase path. */
export function isPaidPlan(planId: string): boolean {
    const tier = TIERS[planId as TierId];
    return tier !== undefined && tier.priceUsd > 0;
}

export function creditsToMicro(credits: number): number {
    return Math.round(credits * MICRO_PER_CREDIT);
}

export function microToCredits(micro: number): number {
    return micro / MICRO_PER_CREDIT;
}

/** USD (float, from estimateCost) → integer micro-USD, for debiting. */
export function usdToMicro(usd: number): number {
    return Math.round(usd * MICRO_PER_USD);
}

/** Micro-USD grant for a plan's monthly credit allotment (unknown → free). */
export function tierGrantMicro(planId: string): number {
    const tier = TIERS[planId as TierId] ?? TIERS.free;
    return creditsToMicro(tier.monthlyCredits);
}
