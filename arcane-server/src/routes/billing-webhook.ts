import { Hono } from 'hono';
import type { AppEnv } from '../types.ts';
import { verifyDodoWebhook } from '../lib/dodo.ts';
import {
    recordBillingEvent, grantPlanCredits, addTopupCredits, setDodoCustomerId,
    upsertSubscription, findSubscriptionById, getNextPeriodStart,
} from '../lib/db.ts';
import { tierGrantMicro, isTierId, creditsToMicro, TOPUP_PACKS, TIERS, type Tier } from '../config/tiers.ts';

export const billingWebhookRouter = new Hono<AppEnv>();

// Shape we rely on from Dodo events. We map an event to OUR user/kind/ref via
// the metadata WE set at checkout (Dodo echoes it back), so business logic
// doesn't depend on Dodo's object layout. Other fields are read defensively.
interface DodoEventData {
    metadata?: Record<string, string>;
    customer?: { customer_id?: string };
    subscription_id?: string;
    id?: string;
    product_id?: string;
    current_period_end?: string;
    next_billing_date?: string;
}

/** Reverse-map a Dodo product id back to a tier via the configured product
 *  vars — a last-resort tier source when neither metadata nor a stored
 *  subscription resolves it. */
function tierFromProductId(env: AppEnv['Bindings'], productId: string | undefined): string | undefined {
    if (!productId) return undefined;
    const bindings = env as unknown as Record<string, string | undefined>;
    for (const tier of Object.values(TIERS) as Tier[]) {
        if (tier.dodoProductVar && bindings[tier.dodoProductVar] === productId) return tier.id;
    }
    return undefined;
}

/**
 * Apply one already-verified, already-deduped webhook event. Exported so tests
 * can drive the business logic with synthetic payloads.
 *
 * Renewal payloads may NOT echo the original checkout metadata, so the user and
 * tier are resolved with fallbacks: metadata first, then the stored
 * subscription row (recorded at subscription.active), then the product id. A
 * paid renewal we can't resolve is SKIPPED — never silently downgraded to free.
 */
export async function handleBillingEvent(
    env: AppEnv['Bindings'], type: string, data: DodoEventData,
): Promise<void> {
    const md = data.metadata ?? {};
    const ref = md.arcane_ref ?? '';
    const kind = md.arcane_kind;
    const subscriptionId = data.subscription_id ?? data.id ?? '';
    const periodEnd = data.current_period_end ?? data.next_billing_date ?? null;

    // Stored subscription is the fallback for renewals with no metadata.
    const stored = subscriptionId ? await findSubscriptionById(env.arcane_db, subscriptionId) : null;

    const userId = md.arcane_user_id ? parseInt(md.arcane_user_id) : (stored?.user_id ?? NaN);
    if (!Number.isInteger(userId)) {
        console.error('billing_event_no_user', JSON.stringify({ type, subscriptionId, metadata: md }));
        return;
    }

    if (data.customer?.customer_id) {
        await setDodoCustomerId(env.arcane_db, userId, data.customer.customer_id).catch(() => {});
    }

    // Tier for subscription events: metadata → stored plan → product-id map.
    const resolvedTier = isTierId(ref) ? ref
        : (stored && isTierId(stored.plan)) ? stored.plan
        : tierFromProductId(env, data.product_id);

    switch (type) {
        case 'subscription.active':
        case 'subscription.renewed': {
            if (!resolvedTier) {
                // Can't tell which paid plan this is — do NOT grant free credits
                // to a paying customer. Log for manual reconciliation.
                console.error('billing_event_unresolved_tier', JSON.stringify({ type, userId, subscriptionId, productId: data.product_id }));
                return;
            }
            await grantPlanCredits(env.arcane_db, userId, resolvedTier, tierGrantMicro(resolvedTier), periodEnd);
            if (subscriptionId) {
                await upsertSubscription(env.arcane_db, {
                    subscriptionId, userId, productId: data.product_id ?? null,
                    plan: resolvedTier, status: 'active', currentPeriodEnd: periodEnd,
                });
            }
            break;
        }

        case 'subscription.on_hold': {
            // Dunning: payment retry pending. Keep the current plan/credits, just
            // record the status so the account UI can warn.
            if (subscriptionId) {
                await upsertSubscription(env.arcane_db, {
                    subscriptionId, userId, productId: data.product_id ?? null,
                    plan: resolvedTier ?? stored?.plan ?? 'free', status: 'on_hold', currentPeriodEnd: periodEnd,
                });
            }
            break;
        }

        case 'subscription.cancelled':
        case 'subscription.failed': {
            // Downgrade to free (top-up credits are untouched — they were paid for).
            await grantPlanCredits(env.arcane_db, userId, 'free', tierGrantMicro('free'), getNextPeriodStart());
            if (subscriptionId) {
                await upsertSubscription(env.arcane_db, {
                    subscriptionId, userId, productId: data.product_id ?? null,
                    plan: 'free', status: type === 'subscription.failed' ? 'failed' : 'cancelled',
                    currentPeriodEnd: periodEnd,
                });
            }
            break;
        }

        case 'payment.succeeded': {
            // Only one-time top-ups grant here; subscription payments are handled
            // by subscription.active/renewed.
            if (kind === 'topup') {
                const pack = TOPUP_PACKS.find(p => p.id === ref);
                if (pack) await addTopupCredits(env.arcane_db, userId, creditsToMicro(pack.credits));
                else console.error('billing_topup_unknown_pack', JSON.stringify({ userId, ref }));
            }
            break;
        }

        case 'payment.failed':
            // Handled via subscription.on_hold; nothing to grant.
            break;

        default:
            // dispute.*/refund.* and any unmapped type — log for now. Revocation
            // rules + exact event names are an owner follow-up (Dodo dashboard).
            console.log('billing_event_unhandled', JSON.stringify({ type, userId }));
    }
}

billingWebhookRouter.post('/v1/billing/webhook', async (c) => {
    // No secret → never trust an unsigned payload. 503 (not 200) so Dodo retries
    // once the owner configures the endpoint.
    const secret = c.env.DODO_WEBHOOK_SECRET;
    if (!secret) return c.json({ error: 'billing_unconfigured' }, 503);

    // Raw body is required for HMAC — must not be re-serialized.
    const raw = await c.req.text();
    const ok = await verifyDodoWebhook(secret, {
        id: c.req.header('webhook-id'),
        timestamp: c.req.header('webhook-timestamp'),
        signature: c.req.header('webhook-signature'),
    }, raw);
    if (!ok) return c.json({ error: 'invalid_signature' }, 400);

    let event: { type?: string; data?: DodoEventData };
    try {
        event = JSON.parse(raw);
    } catch {
        return c.json({ error: 'invalid_json' }, 400);
    }
    const type = event.type ?? 'unknown';
    const webhookId = c.req.header('webhook-id')!; // present (verify passed)

    // Idempotency: record-first, skip duplicates (at-most-once).
    const isNew = await recordBillingEvent(c.env.arcane_db, webhookId, type);
    if (!isNew) return c.json({ ok: true, duplicate: true });

    try {
        await handleBillingEvent(c.env, type, event.data ?? {});
    } catch (err) {
        // Effect failed after we recorded the id → log loudly; a manual replay
        // may be needed. Still 200 so Dodo doesn't hammer a poisoned event.
        console.error('billing_event_apply_failed', JSON.stringify({ type, webhookId, message: err instanceof Error ? err.message : String(err) }));
    }
    return c.json({ ok: true });
});
