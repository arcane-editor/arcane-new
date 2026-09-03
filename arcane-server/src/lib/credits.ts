// The AI-access budget gate, called at the top of every AI route. Two checks:
//   1. Credit balance (with lazy comp-plan expiry) → 402 when empty.
//   2. The $1/hr soft spend cap (anti-abuse backstop) → 429, FREE PLAN ONLY.
//      Paid plans are bounded by their own credit balance (check 1 already
//      caps their spend at what they bought/topped up), so the hourly cap
//      would only throttle a paying customer's legitimate burst; free has no
//      such ceiling of its own, so it keeps the backstop. Paid plans skip the
//      getHourlyCost query entirely — not just the comparison — so a paying
//      user's request never pays for a D1 round trip that can't reject them.
// Debiting happens AFTER the model call, inside recordUsage (src/lib/usage.ts).
import { getHourlyCost, getUserBillingRow, findSubscriptionByUser, expireCompPlan } from './db.ts';
import { isPaidPlan, microToCredits } from '../config/tiers.ts';

const HOURLY_LIMIT_USD = 1.0;

export type BudgetResult =
    | { ok: true; plan: string; balanceMicro: number }
    | {
          ok: false; status: 402 | 429; code: 'credits_exhausted' | 'hourly_cap'; error: string; balanceMicro: number;
          // Present only on the 429 (hourly_cap) — seconds until the oldest
          // request in the current 1h window ages out. Consumed by callers to
          // set the Retry-After header + body field (see routes/chat.ts and
          // its siblings) and, downstream, by the editor's retry logic.
          retryAfterSeconds?: number;
      };

/**
 * Resolve a user's spendable balance, lazily expiring a comp/lapsed-paid plan
 * back to free (no regrant — free credits are a one-time signup trial, see
 * config/tiers.ts's SIGNUP_TRIAL_MICRO). Paid plans are NEVER auto-regranted
 * here — their credits come only from Dodo webhooks, so a lapsed/failed
 * renewal can't hand out free paid credits. Returns balances in micro-USD.
 */
export async function refreshAndGetBalance(
    db: D1Database, userId: number,
): Promise<{ plan: string; planMicro: number; topupMicro: number; planPeriodEnd: string | null }> {
    const row = await getUserBillingRow(db, userId);
    if (!row) return { plan: 'free', planMicro: 0, topupMicro: 0, planPeriodEnd: null };

    const nowIso = new Date().toISOString();
    // Comp expiry: a paid plan past its period end with no live subscription row
    // (comps are granted WITHOUT one) reverts to free — no regrant. Real Dodo
    // subscribers always have a row; 'active' and 'on_hold' (dunning) both
    // protect them.
    if (isPaidPlan(row.plan) && row.plan_period_end && row.plan_period_end <= nowIso) {
        const sub = await findSubscriptionByUser(db, userId);
        if (!sub || (sub.status !== 'active' && sub.status !== 'on_hold')) {
            await expireCompPlan(db, userId);
            return { plan: 'free', planMicro: 0, topupMicro: row.topup_credits_micro, planPeriodEnd: null };
        }
    }
    return { plan: row.plan, planMicro: row.plan_credits_micro, topupMicro: row.topup_credits_micro, planPeriodEnd: row.plan_period_end };
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

    // Anti-abuse hourly spend cap — free plan only (see header comment). Paid
    // plans skip the getHourlyCost query, not just the comparison.
    if (!isPaidPlan(plan)) {
        const { totalCost, oldestTimestamp } = await getHourlyCost(db, userId);
        if (totalCost >= HOURLY_LIMIT_USD) {
            const resetMs = (oldestTimestamp ? new Date(oldestTimestamp).getTime() : Date.now()) + 60 * 60 * 1000;
            const mins = Math.max(1, Math.ceil((resetMs - Date.now()) / 60000));
            const retryAfterSeconds = Math.max(60, Math.ceil((resetMs - Date.now()) / 1000));
            return {
                ok: false, status: 429, code: 'hourly_cap', balanceMicro, retryAfterSeconds,
                error: `Too many AI requests in a short window. Try again in ~${mins} minute(s).`,
            };
        }
    }

    return { ok: true, plan, balanceMicro };
}

/** Convenience for surfaces that show a whole-number-ish credit balance. */
export function balanceToCredits(planMicro: number, topupMicro: number): number {
    return microToCredits(planMicro + topupMicro);
}

/**
 * JSON body for a checkAiBudget failure — shared by every AI route's 402/429
 * response so the shape can't drift between call sites. `retryAfterSeconds`
 * is spread in only when the result carries one (the hourly_cap 429); an
 * older editor reading just `error`/`code` is unaffected either way. Callers
 * still set the `Retry-After` header themselves (a Hono `Context` concern,
 * kept out of this lib file).
 */
export function budgetErrorBody(budget: Extract<BudgetResult, { ok: false }>) {
    return {
        error: budget.error,
        code: budget.code,
        ...(budget.retryAfterSeconds !== undefined ? { retryAfterSeconds: budget.retryAfterSeconds } : {}),
    };
}
