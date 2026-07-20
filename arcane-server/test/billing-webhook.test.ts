import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { signDodoWebhook } from '../src/lib/dodo.ts';
import { getUserBillingRow, findSubscriptionByUser, debitCredits } from '../src/lib/db.ts';
import { tierGrantMicro, creditsToMicro } from '../src/config/tiers.ts';
import { seedPasswordUser } from './helpers.ts';

async function postWebhook(payload: object, opts: { id?: string; badSig?: boolean; ts?: string } = {}): Promise<Response> {
    const raw = JSON.stringify(payload);
    const id = opts.id ?? `wh_${crypto.randomUUID()}`;
    const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
    const signature = opts.badSig ? 'v1,bm90LWEtdmFsaWQ=' : await signDodoWebhook(env.DODO_WEBHOOK_SECRET as string, id, ts, raw);
    return SELF.fetch('https://example.com/v1/billing/webhook', {
        method: 'POST',
        headers: { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': signature, 'Content-Type': 'application/json' },
        body: raw,
    });
}

function subEvent(type: string, userId: number, ref: string, extra: Record<string, unknown> = {}) {
    return { type, data: { metadata: { arcane_user_id: String(userId), arcane_kind: 'subscription', arcane_ref: ref }, subscription_id: `sub_${userId}`, current_period_end: '2099-01-01T00:00:00.000Z', ...extra } };
}

describe('billing webhook', () => {
    it('rejects an invalid signature with 400', async () => {
        const res = await postWebhook({ type: 'payment.succeeded', data: {} }, { badSig: true });
        expect(res.status).toBe(400);
    });

    it('subscription.active grants the tier plan + credits and records the subscription', async () => {
        const u = await seedPasswordUser('wh-active@test.dev', 'password123');
        const res = await postWebhook(subEvent('subscription.active', u.id, 'pro', { customer: { customer_id: 'cus_42' } }));
        expect(res.status).toBe(200);

        const row = await getUserBillingRow(env.arcane_db, u.id);
        expect(row!.plan).toBe('pro');
        expect(row!.plan_credits_micro).toBe(tierGrantMicro('pro'));

        const sub = await findSubscriptionByUser(env.arcane_db, u.id);
        expect(sub!.status).toBe('active');

        const full = await env.arcane_db.prepare('SELECT dodo_customer_id FROM users WHERE id = ?').bind(u.id).first<{ dodo_customer_id: string }>();
        expect(full!.dodo_customer_id).toBe('cus_42');
    });

    it('is idempotent — a replayed webhook-id does not re-grant', async () => {
        const u = await seedPasswordUser('wh-dupe@test.dev', 'password123');
        const id = `wh_${crypto.randomUUID()}`;
        const evt = subEvent('subscription.active', u.id, 'pro');

        expect((await postWebhook(evt, { id })).status).toBe(200);
        // Spend some credits, then replay the same delivery.
        await debitCredits(env.arcane_db, u.id, 1_000_000);
        const spent = (await getUserBillingRow(env.arcane_db, u.id))!.plan_credits_micro;

        const dup = await postWebhook(evt, { id });
        expect(await dup.json()).toEqual({ ok: true, duplicate: true });
        // Balance unchanged by the duplicate (no re-grant back to full).
        expect((await getUserBillingRow(env.arcane_db, u.id))!.plan_credits_micro).toBe(spent);
    });

    it('payment.succeeded for a top-up pack adds top-up credits', async () => {
        const u = await seedPasswordUser('wh-topup@test.dev', 'password123');
        const res = await postWebhook({
            type: 'payment.succeeded',
            data: { metadata: { arcane_user_id: String(u.id), arcane_kind: 'topup', arcane_ref: 'topup_1000' }, id: 'pay_1' },
        });
        expect(res.status).toBe(200);
        const row = await getUserBillingRow(env.arcane_db, u.id);
        expect(row!.topup_credits_micro).toBe(creditsToMicro(1000));
    });

    it('subscription.cancelled downgrades to free (top-up credits preserved)', async () => {
        const u = await seedPasswordUser('wh-cancel@test.dev', 'password123');
        await env.arcane_db.prepare(
            "UPDATE users SET plan='pro', plan_credits_micro=?, topup_credits_micro=? WHERE id=?"
        ).bind(tierGrantMicro('pro'), 250_000, u.id).run();

        const res = await postWebhook(subEvent('subscription.cancelled', u.id, 'pro'));
        expect(res.status).toBe(200);
        const row = await getUserBillingRow(env.arcane_db, u.id);
        expect(row!.plan).toBe('free');
        expect(row!.plan_credits_micro).toBe(tierGrantMicro('free'));
        expect(row!.topup_credits_micro).toBe(250_000); // untouched
    });

    it('renewal WITHOUT metadata resolves user + tier from the stored subscription', async () => {
        const u = await seedPasswordUser('wh-renew@test.dev', 'password123');
        const subId = `sub_renew_${u.id}`;
        // subscription.active carries metadata → records the subscription.
        await postWebhook({ type: 'subscription.active', data: { metadata: { arcane_user_id: String(u.id), arcane_kind: 'subscription', arcane_ref: 'pro' }, subscription_id: subId, current_period_end: '2099-01-01T00:00:00.000Z' } });
        // Spend, then renew with NO metadata — only the subscription id.
        await debitCredits(env.arcane_db, u.id, 500_000);
        const res = await postWebhook({ type: 'subscription.renewed', data: { subscription_id: subId, current_period_end: '2099-02-01T00:00:00.000Z' } });
        expect(res.status).toBe(200);

        const row = await getUserBillingRow(env.arcane_db, u.id);
        expect(row!.plan).toBe('pro');
        expect(row!.plan_credits_micro).toBe(tierGrantMicro('pro')); // regranted to full, not free
    });

    it('skips a paid renewal it cannot resolve (never downgrades to free)', async () => {
        const u = await seedPasswordUser('wh-unresolved@test.dev', 'password123');
        await env.arcane_db.prepare(
            "UPDATE users SET plan='pro', plan_credits_micro=? WHERE id=?"
        ).bind(tierGrantMicro('pro'), u.id).run();
        // Renewal for an unknown subscription, no metadata, no product id.
        const res = await postWebhook({ type: 'subscription.renewed', data: { metadata: { arcane_user_id: String(u.id) }, subscription_id: 'sub_ghost' } });
        expect(res.status).toBe(200);
        const row = await getUserBillingRow(env.arcane_db, u.id);
        expect(row!.plan).toBe('pro'); // untouched — not downgraded
    });

    it('ignores an event whose metadata has no arcane_user_id (no crash)', async () => {
        const res = await postWebhook({ type: 'subscription.active', data: { metadata: {} } });
        expect(res.status).toBe(200); // logged + skipped
    });
});
