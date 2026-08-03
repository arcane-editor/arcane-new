// Allowance gate for POST /v1/completions/inline. Deliberately NOT
// checkAiBudget: inline completions are free (no credit debit) and exempt
// from the $1/hr cap — they are bounded by this per-plan daily counter plus
// the RL_INLINE burst limiter at the route.
import { getUserBillingRow, incrementInlineUsage } from './db.ts';
import { INLINE_DAILY_CAP, type TierId } from '../config/tiers.ts';

export type InlineAllowanceResult =
    | { ok: true; count: number }
    | { ok: false; status: 429; code: 'inline_quota'; error: string; resetAt: string };

export function utcDateKey(now: Date = new Date()): string {
    return now.toISOString().slice(0, 10);
}

export function nextUtcMidnight(now: Date = new Date()): string {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

export async function checkInlineAllowance(
    db: D1Database, userId: number, now: Date = new Date(),
): Promise<InlineAllowanceResult> {
    const row = await getUserBillingRow(db, userId);
    const plan = (row?.plan ?? 'free') as TierId;
    const cap = INLINE_DAILY_CAP[plan] ?? INLINE_DAILY_CAP.free;
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
