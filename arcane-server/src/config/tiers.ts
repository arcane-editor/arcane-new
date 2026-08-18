// Subscription tiers, top-up packs, and the credit⇄cost unit conversions —
// the SINGLE source of truth for pricing. Every dollar figure here is
// ILLUSTRATIVE and rate-table-driven: they are tuned once the real Cloudflare
// neuron costs for our models are confirmed (see costs.ts + the plan's Pricing
// model). Changing a price or grant is a one-file edit.
//
// Unit model: internal accounting is in integer MICRO-USD of *estimated model
// cost*. A user-facing "credit" is $0.01 of that cost. Included credits per
// plan are sized so that $1 of price buys exactly $1 of credits; margin comes
// entirely from MARGIN at debit time.

export const CREDIT_USD = 0.01;                 // 1 credit = $0.01 of model cost
export const MICRO_PER_USD = 1_000_000;
export const MICRO_PER_CREDIT = Math.round(CREDIT_USD * MICRO_PER_USD); // 10,000

/** Cloudflare's fee on prepaid AI Gateway credits (5%). Applied to every AI
 *  request because gateway credits fund both Workers AI and third-party spend. */
export const GATEWAY_FEE = 1.05;

/** Platform markup, applied per request at debit time. This is where margin
 *  lives — NOT in grant sizing. A model price change moves debits with it, so
 *  margin holds without anyone re-deriving a buffer. */
export const MARGIN = 2.0;

export interface Tier {
    id: string;
    name: string;
    priceUsd: number;
    monthlyCredits: number;
    /** Env var holding this tier's Dodo product id (paid tiers only). */
    dodoProductVar?: string;
    order: number;
}

// Grants are exactly priceUsd * 100 — "$20 buys $20 of credits". Margin comes
// entirely from MARGIN at debit time.
// `satisfies` keeps the literal key types so TIERS.free etc. are never
// `undefined` (the codebase runs with noUncheckedIndexedAccess).
export const TIERS = {
    free:    { id: 'free',    name: 'Free',  priceUsd: 0,   monthlyCredits: 150,    order: 0 },
    pro:     { id: 'pro',     name: 'Pro',   priceUsd: 20,  monthlyCredits: 2000,   dodoProductVar: 'DODO_PRODUCT_PRO',     order: 1 },
    proplus: { id: 'proplus', name: 'Pro+',  priceUsd: 50,  monthlyCredits: 5000,   dodoProductVar: 'DODO_PRODUCT_PROPLUS', order: 2 },
    ultra:   { id: 'ultra',   name: 'Ultra', priceUsd: 200, monthlyCredits: 20000,  dodoProductVar: 'DODO_PRODUCT_ULTRA',   order: 3 },
} satisfies Record<string, Tier>;

export type TierId = keyof typeof TIERS;

/** Which effort tiers each plan may request. Deep Think and Max are paid. */
export const ALLOWED_TIERS: Record<TierId, readonly string[]> = {
    free:    ['low'],
    pro:     ['low', 'mid', 'high'],
    proplus: ['low', 'mid', 'high'],
    ultra:   ['low', 'mid', 'high'],
};

/** Legacy wire value `super` is an alias of `high`. */
export function isTierAllowed(planId: string, tier: string): boolean {
    const plan = (isTierId(planId) ? planId : 'free') as TierId;
    const normalized = tier === 'super' ? 'high' : tier;
    return ALLOWED_TIERS[plan].includes(normalized);
}

/** Monthly inline spend ceiling in micro-USD of REAL cost (no margin — inline
 *  is free to the user). Free $1; paid plans 10% of plan price. */
export const INLINE_MONTHLY_MICRO_CEILING: Record<TierId, number> = {
    free: 1_000_000, pro: 2_000_000, proplus: 5_000_000, ultra: 20_000_000,
};

/** Daily suggestion caps, derived from the monthly budget / 30 and rounded to
 *  a clean number. These ration the budget across the month; the micro-USD
 *  ceiling above is the hard backstop, because a request count does not bound
 *  cost — cost scales with context size. */
export const INLINE_DAILY_CAP: Record<TierId, number> = {
    free: 600, pro: 1200, proplus: 3000, ultra: 12000,
};

export interface TopupPack {
    id: string;
    credits: number;
    priceUsd: number;
    dodoProductVar: string;
}

// NOTE: the pack ids and their DODO_PRODUCT_TOPUP_* env vars are LIVE
// provisioned Dodo products — the id no longer matches the credit count, and
// renaming would orphan them. Credits follow the price x 100 rule; the id is
// an internal reference only. Renaming is an owner-gated ops follow-up.
export const TOPUP_PACKS: TopupPack[] = [
    { id: 'topup_1000', credits: 1600, priceUsd: 16, dodoProductVar: 'DODO_PRODUCT_TOPUP_1000' },
    { id: 'topup_5000', credits: 7500, priceUsd: 75, dodoProductVar: 'DODO_PRODUCT_TOPUP_5000' },
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
