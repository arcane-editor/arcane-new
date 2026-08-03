// Subscription tiers, top-up packs, and the credit⇄cost unit conversions —
// the SINGLE source of truth for pricing. Every dollar figure here is
// ILLUSTRATIVE and rate-table-driven: they are tuned once the real Cloudflare
// neuron costs for our models are confirmed (see costs.ts + the plan's Pricing
// model). Changing a price or grant is a one-file edit.
//
// Unit model: internal accounting is in integer MICRO-USD of *estimated model
// cost*. A user-facing "credit" is $0.01 of that cost. Included credits per
// plan are sized so that, after Dodo fees and a SAFETY_BUFFER, a fully-spent
// plan still breaks even (see plan).

export const CREDIT_USD = 0.01;                 // 1 credit = $0.01 of model cost
export const MICRO_PER_USD = 1_000_000;
export const MICRO_PER_CREDIT = Math.round(CREDIT_USD * MICRO_PER_USD); // 10,000
// Cushions the included-credit sizing against under-estimated neuron costs,
// the currently-metered-but-uncertain endpoints, and refunds/disputes.
// Consumed by the tier-grant sizing / pricing, NOT by per-request debit.
export const SAFETY_BUFFER = 1.3;

export interface Tier {
    id: string;
    name: string;
    priceUsd: number;
    monthlyCredits: number;
    /** Env var holding this tier's Dodo product id (paid tiers only). */
    dodoProductVar?: string;
    order: number;
}

// Cursor-style ladder. Grants are illustrative (≥ break-even); Ultra is capped
// at break-even, NOT Cursor's below-cost 20× — see the plan's caveat.
// `satisfies` keeps the literal key types so TIERS.free etc. are never
// `undefined` (the codebase runs with noUncheckedIndexedAccess).
export const TIERS = {
    free:    { id: 'free',    name: 'Free',  priceUsd: 0,   monthlyCredits: 150,    order: 0 },
    pro:     { id: 'pro',     name: 'Pro',   priceUsd: 20,  monthlyCredits: 1400,   dodoProductVar: 'DODO_PRODUCT_PRO',     order: 1 },
    proplus: { id: 'proplus', name: 'Pro+',  priceUsd: 50,  monthlyCredits: 3600,   dodoProductVar: 'DODO_PRODUCT_PROPLUS', order: 2 },
    ultra:   { id: 'ultra',   name: 'Ultra', priceUsd: 200, monthlyCredits: 16000,  dodoProductVar: 'DODO_PRODUCT_ULTRA',   order: 3 },
} satisfies Record<string, Tier>;

export type TierId = keyof typeof TIERS;

/** Daily inline (tab) completion allowance per plan — abuse ceilings, not
 *  billing: inline completions never debit credits (2026-08-03 design). */
export const INLINE_DAILY_CAP: Record<TierId, number> = {
    free: 300, pro: 4000, proplus: 10000, ultra: 10000,
};

export interface TopupPack {
    id: string;
    credits: number;
    priceUsd: number;
    dodoProductVar: string;
}

// One-time credit packs (priced for ~10% net profit over buffered cost + Dodo
// one-time fee — see plan). Illustrative until real costs land.
export const TOPUP_PACKS: TopupPack[] = [
    { id: 'topup_1000', credits: 1000, priceUsd: 16, dodoProductVar: 'DODO_PRODUCT_TOPUP_1000' },
    { id: 'topup_5000', credits: 5000, priceUsd: 75, dodoProductVar: 'DODO_PRODUCT_TOPUP_5000' },
];

export function isTierId(x: string): boolean {
    return Object.prototype.hasOwnProperty.call(TIERS, x);
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
