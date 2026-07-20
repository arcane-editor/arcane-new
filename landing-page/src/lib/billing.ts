// Billing API client — mirrors src/lib/auth.ts conventions (PUBLIC_API_URL,
// status-carrying errors). Checkout/portal return a Dodo hosted URL the caller
// redirects to; plans is public; usage carries the credit balance.
const API_URL = import.meta.env.PUBLIC_API_URL || 'https://api.arcaneai.org';

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
