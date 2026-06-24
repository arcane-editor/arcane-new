import { Hono } from 'hono';
import { findCurrentUsagePeriod, findRecentRequestLogs, getCurrentPeriodStart } from '../lib/db.ts';
import { authMiddleware } from '../middleware/auth.ts';
import type { AuthPayload } from '../middleware/auth.ts';
import type { AppEnv } from '../types.ts';

export const usageRouter = new Hono<AppEnv>();

usageRouter.get('/v1/usage', authMiddleware(), async (c) => {
    const user = c.get('user') as AuthPayload;
    const db = c.env.arcane_db;

    const periodStart = getCurrentPeriodStart();
    const currentPeriod = await findCurrentUsagePeriod(db, parseInt(user.sub), periodStart);
    const recentRequests = await findRecentRequestLogs(db, parseInt(user.sub), 50);

    return c.json({
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
