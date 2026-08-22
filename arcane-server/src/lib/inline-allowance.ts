// Allowance gate for POST /v1/completions/inline. Deliberately NOT
// checkAiBudget: inline completions are free (no credit debit) and exempt from
// the $1/hr cap. Three checks apply, in this order:
//
//   0. A feature-lock check: free (and any unrecognised plan) gets NO inline
//      completions at all — INLINE_DAILY_CAP[plan] === 0 means "not on this
//      plan", not "quota of zero". This runs before anything else, including
//      the daily counter bump, so a locked-out user's counter never moves.
//   1. A monthly micro-USD CEILING on real spend — the hard backstop, because
//      a request count does not bound cost (cost scales with FIM context).
//   2. A daily request cap that rations that budget across the month, so a
//      user cannot exhaust it in the first few days and face three dead weeks.
//
// The ceiling is checked before the daily counter is bumped, so a user
// already over budget never burns a daily slot.
import { getUserBillingRow, incrementInlineUsage, getInlineSpend } from './db.ts';
import { INLINE_DAILY_CAP, INLINE_MONTHLY_MICRO_CEILING, type TierId } from '../config/tiers.ts';

export type InlineAllowanceResult =
    | { ok: true; count: number }
    | { ok: false; status: 403; code: 'inline_not_available'; error: string; requiredPlan: 'starter' }
    | { ok: false; status: 429; code: 'inline_quota'; error: string; resetAt: string }
    | { ok: false; status: 402; code: 'inline_budget_exhausted'; error: string; resetAt: string };

export function utcDateKey(now: Date = new Date()): string {
    return now.toISOString().slice(0, 10);
}

export function utcMonthKey(now: Date = new Date()): string {
    return now.toISOString().slice(0, 7);
}

export function nextUtcMidnight(now: Date = new Date()): string {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

export function nextUtcMonth(now: Date = new Date()): string {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

export async function checkInlineAllowance(
    db: D1Database, userId: number, now: Date = new Date(),
): Promise<InlineAllowanceResult> {
    const row = await getUserBillingRow(db, userId);
    const plan = (row?.plan ?? 'free') as TierId;

    const cap = INLINE_DAILY_CAP[plan] ?? INLINE_DAILY_CAP.free;
    if (cap === 0) {
        return {
            ok: false, status: 403, code: 'inline_not_available',
            error: 'Tab completions are a paid-plan feature. Upgrade to Starter or above to enable them.',
            requiredPlan: 'starter',
        };
    }

    const ceiling = INLINE_MONTHLY_MICRO_CEILING[plan] ?? INLINE_MONTHLY_MICRO_CEILING.free;
    const spent = await getInlineSpend(db, userId, utcMonthKey(now));
    if (spent >= ceiling) {
        return {
            ok: false, status: 402, code: 'inline_budget_exhausted',
            error: 'Tab completions for this month are used up. They reset at the start of next month.',
            resetAt: nextUtcMonth(now),
        };
    }

    const count = await incrementInlineUsage(db, userId, utcDateKey(now));
    if (count > cap) {
        return {
            ok: false, status: 429, code: 'inline_quota',
            error: `Daily completion limit reached (${cap}/day on your plan). Suggestions resume at midnight UTC.`,
            resetAt: nextUtcMidnight(now),
        };
    }
    return { ok: true, count };
}
