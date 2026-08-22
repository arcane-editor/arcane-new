import { Hono } from 'hono';
import { findCurrentUsagePeriod, findRecentRequestLogs, getCurrentPeriodStart } from '../lib/db.ts';
import { authMiddleware } from '../middleware/auth.ts';
import type { AuthPayload } from '../middleware/auth.ts';
import type { AppEnv } from '../types.ts';
import { refreshAndGetBalance } from '../lib/credits.ts';
import { microToCredits } from '../config/tiers.ts';

export const usageRouter = new Hono<AppEnv>();

usageRouter.get('/v1/usage', authMiddleware(), async (c) => {
    const user = c.get('user') as AuthPayload;
    const db = c.env.arcane_db;
    const userId = parseInt(user.sub);

    // Lazily expire a comp/lapsed-paid plan back to free if it rolled past its
    // period end unprotected, so the balance shown here matches what the AI
    // gate would enforce on the next request.
    const { plan, planMicro, topupMicro, planPeriodEnd } = await refreshAndGetBalance(db, userId);

    const periodStart = getCurrentPeriodStart();
    const currentPeriod = await findCurrentUsagePeriod(db, userId, periodStart);
    const recentRequests = await findRecentRequestLogs(db, userId, 50);

    return c.json({
        plan,
        credits: {
            balance: microToCredits(planMicro + topupMicro),
            plan: microToCredits(planMicro),
            topup: microToCredits(topupMicro),
        },
        planPeriodEnd,
        currentPeriod: {
            start: periodStart,
            totalRequests: currentPeriod?.total_requests ?? 0,
            totalInputTokens: currentPeriod?.total_input_tokens ?? 0,
            totalOutputTokens: currentPeriod?.total_output_tokens ?? 0,
            totalCostUsd: currentPeriod?.total_cost_usd ?? 0,
        },
        recentRequests: recentRequests.map(r => ({
            model: r.model,
            inputTokens: r.input_tokens,
            outputTokens: r.output_tokens,
            costUsd: r.cost_usd,
            durationMs: r.duration_ms,
            createdAt: r.created_at,
        })),
    });
});
