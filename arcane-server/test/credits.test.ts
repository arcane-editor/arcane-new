import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { debitCredits, getUserBillingRow, grantPlanCredits, addTopupCredits, upsertSubscription, createRequestLog } from '../src/lib/db.ts';
import * as db from '../src/lib/db.ts';
import { checkAiBudget, refreshAndGetBalance } from '../src/lib/credits.ts';
import { tierGrantMicro } from '../src/config/tiers.ts';
import { seedPasswordUser } from './helpers.ts';

/** Seeds a request_logs row that alone busts the $1/hr anti-abuse cap
 *  (HOURLY_LIMIT_USD in credits.ts) — created_at defaults to now, so it
 *  always lands inside getHourlyCost's 1h window. */
async function seedOverHourlyCap(userId: number): Promise<void> {
    await createRequestLog(env.arcane_db, {
        userId, model: 'test-model', inputTokens: 100, outputTokens: 100,
        costUsd: 1.5, durationMs: 100,
    });
}

async function setBalances(id: number, plan: string, planMicro: number, topupMicro: number, periodEnd: string | null) {
    await env.arcane_db.prepare(
        'UPDATE users SET plan = ?, plan_credits_micro = ?, topup_credits_micro = ?, plan_period_end = ? WHERE id = ?'
    ).bind(plan, planMicro, topupMicro, periodEnd, id).run();
}

describe('debitCredits — plan bucket first, then top-up', () => {
    it('debits wholly from the plan bucket when it covers the cost', async () => {
        const u = await seedPasswordUser('deb1@test.dev', 'password123');
        await setBalances(u.id, 'pro', 1_000_000, 500_000, '2099-01-01T00:00:00.000Z');
        await debitCredits(env.arcane_db, u.id, 300_000);
        const r = await getUserBillingRow(env.arcane_db, u.id);
        expect(r!.plan_credits_micro).toBe(700_000);
        expect(r!.topup_credits_micro).toBe(500_000);
    });

    it('spills the overflow into top-up once the plan bucket is exhausted', async () => {
        const u = await seedPasswordUser('deb2@test.dev', 'password123');
        await setBalances(u.id, 'pro', 1_000_000, 2_000_000, '2099-01-01T00:00:00.000Z');
        await debitCredits(env.arcane_db, u.id, 1_500_000);
        const r = await getUserBillingRow(env.arcane_db, u.id);
        expect(r!.plan_credits_micro).toBe(0);
        expect(r!.topup_credits_micro).toBe(1_500_000); // 2_000_000 - (1_500_000 - 1_000_000)
    });

    it('lets a final over-budget request take top-up slightly negative', async () => {
        const u = await seedPasswordUser('deb3@test.dev', 'password123');
        await setBalances(u.id, 'pro', 100_000, 50_000, '2099-01-01T00:00:00.000Z');
        await debitCredits(env.arcane_db, u.id, 500_000);
        const r = await getUserBillingRow(env.arcane_db, u.id);
        expect(r!.plan_credits_micro).toBe(0);
        expect(r!.topup_credits_micro).toBe(-350_000); // 50_000 - (500_000 - 100_000)
    });
});

describe('refreshAndGetBalance — free never regrants', () => {
    it('a free user with an unanchored (NULL) period stays at their current balance', async () => {
        const u = await seedPasswordUser('free1@test.dev', 'password123'); // defaults: free, 0, NULL
        await setBalances(u.id, 'free', 0, 0, null);
        const bal = await refreshAndGetBalance(env.arcane_db, u.id);
        expect(bal.planMicro).toBe(0); // no lazy regrant — free credits are a one-time signup trial
        const r = await getUserBillingRow(env.arcane_db, u.id);
        expect(r!.plan_period_end).toBeNull(); // never anchored — free has no cycle
    });

    it('does not touch a free user whose period is in the future', async () => {
        const u = await seedPasswordUser('free2@test.dev', 'password123');
        await setBalances(u.id, 'free', 0, 0, '2099-01-01T00:00:00.000Z');
        const bal = await refreshAndGetBalance(env.arcane_db, u.id);
        expect(bal.planMicro).toBe(0);
    });
});

// Comp/lapsed-paid lazy expiry (replaces the deleted free-monthly-reset path):
// a paid plan past its period end with no live subscription row reverts to
// free with NO regrant. Real Dodo subscribers always have a subscriptions
// row; 'active' and 'on_hold' (dunning) both protect the plan from expiry.
describe('refreshAndGetBalance — comp/lapsed-paid lazy expiry', () => {
    it('reverts to free when past period end with no subscription row', async () => {
        const u = await seedPasswordUser('comp-expire@test.dev', 'password123');
        await setBalances(u.id, 'pro', 500_000, 200_000, '2000-01-01T00:00:00.000Z'); // long expired, comped
        const bal = await refreshAndGetBalance(env.arcane_db, u.id);
        expect(bal.plan).toBe('free');
        expect(bal.planMicro).toBe(0);
        expect(bal.topupMicro).toBe(200_000); // top-ups kept
        expect(bal.planPeriodEnd).toBeNull();

        const r = await getUserBillingRow(env.arcane_db, u.id);
        expect(r!.plan).toBe('free');
        expect(r!.plan_credits_micro).toBe(0);
        expect(r!.topup_credits_micro).toBe(200_000);
        expect(r!.plan_period_end).toBeNull();
    });

    it('leaves an expired plan untouched when a subscription row is active', async () => {
        const u = await seedPasswordUser('comp-active@test.dev', 'password123');
        await setBalances(u.id, 'pro', 500_000, 0, '2000-01-01T00:00:00.000Z');
        await upsertSubscription(env.arcane_db, {
            subscriptionId: `sub_active_${u.id}`, userId: u.id, productId: null,
            plan: 'pro', status: 'active', currentPeriodEnd: '2000-01-01T00:00:00.000Z',
        });
        const bal = await refreshAndGetBalance(env.arcane_db, u.id);
        expect(bal.plan).toBe('pro');
        expect(bal.planMicro).toBe(500_000); // untouched — a live subscriber, not a comp

        const r = await getUserBillingRow(env.arcane_db, u.id);
        expect(r!.plan).toBe('pro');
    });

    it('leaves an expired plan untouched when the subscription is on_hold (dunning)', async () => {
        const u = await seedPasswordUser('comp-onhold@test.dev', 'password123');
        await setBalances(u.id, 'pro', 500_000, 0, '2000-01-01T00:00:00.000Z');
        await upsertSubscription(env.arcane_db, {
            subscriptionId: `sub_onhold_${u.id}`, userId: u.id, productId: null,
            plan: 'pro', status: 'on_hold', currentPeriodEnd: '2000-01-01T00:00:00.000Z',
        });
        const bal = await refreshAndGetBalance(env.arcane_db, u.id);
        expect(bal.plan).toBe('pro');
        expect(bal.planMicro).toBe(500_000);
    });

    it('a subscription row that is cancelled does not protect the plan', async () => {
        const u = await seedPasswordUser('comp-cancelled@test.dev', 'password123');
        await setBalances(u.id, 'pro', 500_000, 0, '2000-01-01T00:00:00.000Z');
        await upsertSubscription(env.arcane_db, {
            subscriptionId: `sub_cancelled_${u.id}`, userId: u.id, productId: null,
            plan: 'pro', status: 'cancelled', currentPeriodEnd: '2000-01-01T00:00:00.000Z',
        });
        const bal = await refreshAndGetBalance(env.arcane_db, u.id);
        expect(bal.plan).toBe('free');
        expect(bal.planMicro).toBe(0);
    });

    it('never expires a paid plan whose period is still in the future', async () => {
        const u = await seedPasswordUser('comp-future@test.dev', 'password123');
        await setBalances(u.id, 'pro', 500_000, 0, '2099-01-01T00:00:00.000Z');
        const bal = await refreshAndGetBalance(env.arcane_db, u.id);
        expect(bal.plan).toBe('pro');
        expect(bal.planMicro).toBe(500_000);
    });

    it('the free plan never expires (nothing to expire) and never regrants', async () => {
        const u = await seedPasswordUser('comp-free@test.dev', 'password123');
        await setBalances(u.id, 'free', 0, 0, '2000-01-01T00:00:00.000Z'); // a stray past date on free
        const bal = await refreshAndGetBalance(env.arcane_db, u.id);
        expect(bal.plan).toBe('free');
        expect(bal.planMicro).toBe(0);
    });
});

describe('checkAiBudget', () => {
    it('402 credits_exhausted when the balance is empty', async () => {
        const u = await seedPasswordUser('gate402@test.dev', 'password123');
        await setBalances(u.id, 'pro', 0, 0, '2099-01-01T00:00:00.000Z');
        const res = await checkAiBudget(env.arcane_db, u.id);
        expect(res.ok).toBe(false);
        if (!res.ok) { expect(res.status).toBe(402); expect(res.code).toBe('credits_exhausted'); }
    });

    it('passes when top-up credits are available', async () => {
        const u = await seedPasswordUser('gateok@test.dev', 'password123');
        await setBalances(u.id, 'free', 0, 250_000, '2099-01-01T00:00:00.000Z');
        const res = await checkAiBudget(env.arcane_db, u.id);
        expect(res.ok).toBe(true);
    });

    it('grantPlanCredits + addTopupCredits move the gate from blocked to open', async () => {
        const u = await seedPasswordUser('gategrant@test.dev', 'password123');
        await setBalances(u.id, 'pro', 0, 0, '2099-01-01T00:00:00.000Z');
        expect((await checkAiBudget(env.arcane_db, u.id)).ok).toBe(false);
        await grantPlanCredits(env.arcane_db, u.id, 'pro', tierGrantMicro('pro'), '2099-02-01T00:00:00.000Z');
        expect((await checkAiBudget(env.arcane_db, u.id)).ok).toBe(true);
        await addTopupCredits(env.arcane_db, u.id, 100_000);
        const r = await getUserBillingRow(env.arcane_db, u.id);
        expect(r!.topup_credits_micro).toBe(100_000);
    });
});

// The $1/hr anti-abuse backstop is a FREE-PLAN-ONLY check (owner decision):
// paid plans are already bounded by their own credit balance, so the hourly
// cap would only throttle a paying customer's legitimate burst. Paid plans
// must skip the getHourlyCost query entirely, not just the comparison.
describe('checkAiBudget — hourly cap is free-plan only', () => {
    it('429 hourly_cap for a free user over $1/h, with retryAfterSeconds in the expected window', async () => {
        const u = await seedPasswordUser('hourly-free@test.dev', 'password123');
        await setBalances(u.id, 'free', 500_000, 0, null);
        await seedOverHourlyCap(u.id);

        const res = await checkAiBudget(env.arcane_db, u.id);
        expect(res.ok).toBe(false);
        if (res.ok) throw new Error('unreachable');
        expect(res.status).toBe(429);
        expect(res.code).toBe('hourly_cap');
        // resetMs ~= now + 1h (the seeded row's created_at is ~now), so
        // retryAfterSeconds should sit just under the 3600s ceiling and
        // comfortably clear the 60s floor.
        expect(res.retryAfterSeconds).toBeGreaterThan(3000);
        expect(res.retryAfterSeconds).toBeLessThanOrEqual(3600);
    });

    it('a paid user over $1/h passes, and the hourly query never runs', async () => {
        const u = await seedPasswordUser('hourly-paid@test.dev', 'password123');
        await setBalances(u.id, 'pro', 500_000, 0, '2099-01-01T00:00:00.000Z');
        await seedOverHourlyCap(u.id);

        const spy = vi.spyOn(db, 'getHourlyCost');
        try {
            const res = await checkAiBudget(env.arcane_db, u.id);
            expect(res.ok).toBe(true);
            expect(spy).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });

    it('a free user under $1/h passes (no retryAfterSeconds field on ok results)', async () => {
        const u = await seedPasswordUser('hourly-free-ok@test.dev', 'password123');
        await setBalances(u.id, 'free', 500_000, 0, null);
        const res = await checkAiBudget(env.arcane_db, u.id);
        expect(res.ok).toBe(true);
    });
});
