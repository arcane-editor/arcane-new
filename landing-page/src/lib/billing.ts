// Billing API client — mirrors src/lib/auth.ts conventions (PUBLIC_API_URL,
// status-carrying errors). Checkout/portal return a Dodo hosted URL the caller
// redirects to; plans is public; usage carries the credit balance.
const API_URL = import.meta.env.PUBLIC_API_URL || 'https://api.unityide.app';

export interface PlanTier {
    id: string;
    name: string;
    priceUsd: number;
    monthlyCredits: number;
    order: number;
}

export interface TopupPack {
    id: string;
    credits: number;
    priceUsd: number;
}

export interface PlansResponse {
    tiers: PlanTier[];
    topups: TopupPack[];
}

/** Top-ups are a paid-plan feature (server gate: `plan_required`, 403).
 *  Derived from the tier ladder the server serves rather than a hardcoded
 *  list, so `arcane-server/src/config/tiers.ts` stays the single source of
 *  truth. An unknown plan — or an empty ladder because /plans failed — is
 *  false, matching the server's allowlist and failing closed. */
export function canBuyTopups(plan: string, tiers: PlanTier[]): boolean {
    const tier = tiers.find(t => t.id === plan);
    return tier !== undefined && tier.priceUsd > 0;
}

/**
 * Percent of `grant` that has been spent, as a clamped integer 0-100.
 * Callers derive "N% left" as `100 - usagePercent(...)` — this always reports
 * the *used* share so BillingPanel's "N% used" / "N% left" pair can never
 * drift out of sync with each other.
 *
 * `grant <= 0` is a guard state (no monthly grant to measure against, e.g. an
 * unknown/legacy plan): reports 100% used only when `balance` is also <= 0
 * (nothing left either way), else 0% — there's no grant to divide by, so
 * treating unexplained balance as "fully used" would be actively misleading.
 *
 * A `balance` above `grant` (a race that briefly overcredits) or below 0 (a
 * race that overdrafts — see db.ts's topup debt comment) both clamp into
 * range rather than reporting a nonsensical negative or >100% figure.
 */
export function usagePercent(grant: number, balance: number): number {
    if (grant <= 0) return balance <= 0 ? 100 : 0;
    const pct = Math.round((100 * (grant - balance)) / grant);
    return Math.max(0, Math.min(100, pct));
}

export interface UsageResponse {
    plan: string;
    credits: { balance: number; plan: number; topup: number };
    planPeriodEnd: string | null;
    currentPeriod: {
        start: string;
        totalRequests: number;
        totalInputTokens: number;
        totalOutputTokens: number;
        totalCostUsd: number;
    };
    recentRequests: Array<{
        model: string; inputTokens: number; outputTokens: number;
        costUsd: number; durationMs: number; createdAt: string;
    }>;
}

/** Error that carries the HTTP status + server `code` so callers can tell
 *  "billing not configured yet" (503) apart from a real failure. */
export class BillingError extends Error {
    status: number;
    code?: string;
    constructor(message: string, status: number, code?: string) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

async function billingError(res: Response, fallback: string): Promise<BillingError> {
    let message = fallback;
    let code: string | undefined;
    try {
        const data = await res.json();
        message = data.error || fallback;
        code = data.code;
    } catch { /* non-JSON edge error page */ }
    return new BillingError(message, res.status, code);
}

/** Public — the pricing ladder (no auth). */
export async function apiGetPlans(): Promise<PlansResponse> {
    const res = await fetch(`${API_URL}/v1/billing/plans`);
    if (!res.ok) throw await billingError(res, 'Could not load plans');
    return res.json();
}

/** Authenticated — plan + credit balance + this period's usage. */
export async function apiGetUsage(token: string): Promise<UsageResponse> {
    const res = await fetch(`${API_URL}/v1/usage`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw await billingError(res, 'Could not load usage');
    return res.json();
}

/** Start a Dodo checkout for a subscription tier OR a one-time top-up pack.
 *  Returns the hosted checkout URL to redirect to. */
export async function apiStartCheckout(
    token: string, selection: { tier: string } | { pack: string },
): Promise<{ checkoutUrl: string }> {
    const res = await fetch(`${API_URL}/v1/billing/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(selection),
    });
    if (!res.ok) throw await billingError(res, 'Could not start checkout');
    return res.json();
}

/** Hosted customer-portal link to manage/cancel a subscription. */
export async function apiOpenPortal(token: string): Promise<{ portalUrl: string }> {
    const res = await fetch(`${API_URL}/v1/billing/portal`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw await billingError(res, 'Could not open the billing portal');
    return res.json();
}
