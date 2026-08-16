import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { debitCredits, getUserBillingRow, grantPlanCredits, addTopupCredits } from '../src/lib/db.ts';
import { checkAiBudget, refreshAndGetBalance } from '../src/lib/credits.ts';
import { tierGrantMicro } from '../src/config/tiers.ts';
import { seedPasswordUser } from './helpers.ts';

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

describe('refreshAndGetBalance — free monthly reset', () => {
    it('grants the free allotment when the period is unanchored (NULL)', async () => {
        const u = await seedPasswordUser('free1@test.dev', 'password123'); // defaults: free, 0, NULL
        await setBalances(u.id, 'free', 0, 0, null);
        const bal = await refreshAndGetBalance(env.arcane_db, u.id);
        expect(bal.planMicro).toBe(tierGrantMicro('free'));
        const r = await getUserBillingRow(env.arcane_db, u.id);
        expect(r!.plan_period_end).not.toBeNull(); // anchor was set
    });

    it('does not reset a free user whose period is still in the future', async () => {
        const u = await seedPasswordUser('free2@test.dev', 'password123');
        await setBalances(u.id, 'free', 0, 0, '2099-01-01T00:00:00.000Z');
        const bal = await refreshAndGetBalance(env.arcane_db, u.id);
        expect(bal.planMicro).toBe(0);
    });

    it('NEVER auto-regrants a paid plan, even past its period end', async () => {
        const u = await seedPasswordUser('paid1@test.dev', 'password123');
        await setBalances(u.id, 'pro', 0, 0, '2000-01-01T00:00:00.000Z'); // long expired
        const bal = await refreshAndGetBalance(env.arcane_db, u.id);
        expect(bal.plan).toBe('pro');
        expect(bal.planMicro).toBe(0); // failed renewal must not hand out free paid credits
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

// P0 fix wave 2026-08-16: a final-request overshoot leaves top-up NEGATIVE
// (see debitCredits above). The monthly reset used to SET only the plan
// bucket, so that debt survived every reset — permanently taxing each
// month's grant, cleared only when a purchased top-up silently paid it off.
describe('resetFreePlanCredits — overshoot debt settles at the monthly reset', () => {
    it('settles a negative top-up from the new grant', async () => {
        const u = await seedPasswordUser('debt1@test.dev', 'password123');
        await setBalances(u.id, 'free', 0, -350_000, '2000-01-01T00:00:00.000Z');
        await refreshAndGetBalance(env.arcane_db, u.id);
        const r = await getUserBillingRow(env.arcane_db, u.id);
        expect(r!.topup_credits_micro).toBe(0);
        expect(r!.plan_credits_micro).toBe(tierGrantMicro('free') - 350_000);
    });

    it('carries debt larger than the grant instead of vanishing or compounding', async () => {
        const u = await seedPasswordUser('debt2@test.dev', 'password123');
        const grant = tierGrantMicro('free');
        await setBalances(u.id, 'free', 0, -(grant + 500_000), '2000-01-01T00:00:00.000Z');
        await refreshAndGetBalance(env.arcane_db, u.id);
        const r = await getUserBillingRow(env.arcane_db, u.id);
        expect(r!.plan_credits_micro).toBe(0);
        expect(r!.topup_credits_micro).toBe(-500_000);
    });

    it('leaves a positive top-up untouched by the reset', async () => {
        const u = await seedPasswordUser('debt3@test.dev', 'password123');
        await setBalances(u.id, 'free', 0, 100_000, '2000-01-01T00:00:00.000Z');
        await refreshAndGetBalance(env.arcane_db, u.id);
        const r = await getUserBillingRow(env.arcane_db, u.id);
        expect(r!.plan_credits_micro).toBe(tierGrantMicro('free'));
        expect(r!.topup_credits_micro).toBe(100_000);
    });
});
