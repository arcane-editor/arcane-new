// The AI-access budget gate, called at the top of every AI route. Two checks:
//   1. Credit balance (with a lazy free-tier monthly reset) → 402 when empty.
//   2. The $1/hr soft spend cap (anti-abuse backstop, unchanged) → 429.
// Debiting happens AFTER the model call, inside recordUsage (src/lib/usage.ts).
import { getHourlyCost, getUserBillingRow, resetFreePlanCredits, getNextPeriodStart } from './db.ts';
import { tierGrantMicro, microToCredits } from '../config/tiers.ts';

const HOURLY_LIMIT_USD = 1.0;

export type BudgetResult =
    | { ok: true; plan: string; balanceMicro: number }
    | { ok: false; status: 402 | 429; code: 'credits_exhausted' | 'rate_limited'; error: string; balanceMicro: number };

/**
 * Resolve a user's spendable balance, refreshing the free tier's monthly grant
 * if the period rolled over. Paid plans are NEVER auto-regranted here — their
 * credits come only from Dodo webhooks, so a lapsed/failed renewal can't hand
 * out free paid credits. Returns balances in micro-USD.
 */
export async function refreshAndGetBalance(
    db: D1Database, userId: number,
): Promise<{ plan: string; planMicro: number; topupMicro: number; planPeriodEnd: string | null }> {
    const row = await getUserBillingRow(db, userId);
    if (!row) return { plan: 'free', planMicro: 0, topupMicro: 0, planPeriodEnd: null };

    let planMicro = row.plan_credits_micro;
    let planPeriodEnd = row.plan_period_end;
    const nowIso = new Date().toISOString();
    if (row.plan === 'free' && (row.plan_period_end === null || row.plan_period_end <= nowIso)) {
        planMicro = tierGrantMicro('free');
        planPeriodEnd = getNextPeriodStart();
        await resetFreePlanCredits(db, userId, planMicro, planPeriodEnd);
    }
    return { plan: row.plan, planMicro, topupMicro: row.topup_credits_micro, planPeriodEnd };
}

export async function checkAiBudget(db: D1Database, userId: number): Promise<BudgetResult> {
    const { plan, planMicro, topupMicro } = await refreshAndGetBalance(db, userId);
    const balanceMicro = planMicro + topupMicro;

    if (balanceMicro <= 0) {
        return {
            ok: false, status: 402, code: 'credits_exhausted', balanceMicro,
            error: 'You are out of credits. Upgrade your plan or add a top-up to keep using AI.',
        };
    }

    // Anti-abuse hourly spend cap (defense in depth; behavior unchanged).
    const { totalCost, oldestTimestamp } = await getHourlyCost(db, userId);
    if (totalCost >= HOURLY_LIMIT_USD) {
        const resetMs = (oldestTimestamp ? new Date(oldestTimestamp).getTime() : Date.now()) + 60 * 60 * 1000;
        const mins = Math.max(1, Math.ceil((resetMs - Date.now()) / 60000));
        return {
            ok: false, status: 429, code: 'rate_limited', balanceMicro,
            error: `Too many AI requests in a short window. Try again in ~${mins} minute(s).`,
        };
    }

    return { ok: true, plan, balanceMicro };
}

/** Convenience for surfaces that show a whole-number-ish credit balance. */
export function balanceToCredits(planMicro: number, topupMicro: number): number {
    return microToCredits(planMicro + topupMicro);
}
