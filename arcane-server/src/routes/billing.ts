import { Hono } from 'hono';
import type { AppEnv } from '../types.ts';
import { authMiddleware, requireVerifiedEmail } from '../middleware/auth.ts';
import type { AuthPayload } from '../middleware/auth.ts';
import { findUserById } from '../lib/db.ts';
import { TIERS, TOPUP_PACKS, isTierId, isPaidPlan, type Tier, type TierId } from '../config/tiers.ts';
import { createDodoCheckout, createDodoCustomerPortal, dodoApiBase } from '../lib/dodo.ts';

export const billingRouter = new Hono<AppEnv>();

/** Reads a Dodo product-id var by name off the (typed) bindings. */
function productId(env: AppEnv['Bindings'], varName: string | undefined): string | undefined {
    if (!varName) return undefined;
    const v = (env as unknown as Record<string, string | undefined>)[varName];
    return v && v.length > 0 ? v : undefined;
}

// Public: the pricing ladder for the website (single source = src/config/tiers.ts).
billingRouter.get('/v1/billing/plans', (c) => {
    return c.json({
        tiers: Object.values(TIERS).map(t => ({
            id: t.id, name: t.name, priceUsd: t.priceUsd, monthlyCredits: t.monthlyCredits, order: t.order,
        })),
        topups: TOPUP_PACKS.map(p => ({ id: p.id, credits: p.credits, priceUsd: p.priceUsd })),
    });
});

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

// Hosted portal link to manage / cancel an existing subscription.
billingRouter.post('/v1/billing/portal', authMiddleware(), async (c) => {
    if (!c.env.DODO_API_KEY) {
        return c.json({ error: 'Billing is not available yet.', code: 'billing_unconfigured' }, 503);
    }
    const user = c.get('user') as AuthPayload;
    const full = await findUserById(c.env.arcane_db, parseInt(user.sub));
    if (!full?.dodo_customer_id) {
        return c.json({ error: 'No billing account yet.', code: 'no_customer' }, 400);
    }
    try {
        const portalUrl = await createDodoCustomerPortal(
            c.env.DODO_API_KEY, dodoApiBase(c.env.ENVIRONMENT), full.dodo_customer_id,
        );
        return c.json({ portalUrl });
    } catch (err) {
        console.error('portal_failed', err instanceof Error ? err.message : String(err));
        return c.json({ error: 'Could not open the billing portal.', code: 'portal_failed' }, 502);
    }
});
