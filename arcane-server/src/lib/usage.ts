// Shared AI-usage metering. Every AI route (chat, embeddings, graph enrich,
// unity search) funnels its per-request token counts through here so that
// `request_logs` + `usage_periods` reflect ALL neuron spend — not just chat.
// Cost is derived from the model's catalog rate (see costs.ts). Historically
// only chat.ts wrote usage; embeddings/graph/unity burned neurons but recorded
// $0, under-counting real cost and (later) credit consumption.
import { estimateCost } from './costs.ts';
import { upsertUsagePeriod, createRequestLog, getCurrentPeriodStart, getNextPeriodStart } from './db.ts';

// Optional per-request telemetry (chat harness counters — see migration 0011).
// Non-chat routes pass at most `taskType`.
export interface UsageExtras {
    taskType?: string;
    turnIndex?: number;
    toolErrorCount?: number;
    repairCount?: number;
    cachedInputTokens?: number;
    groundingLintHits?: number;
    loopGuardHits?: number;
    escalated?: boolean;
    groundingToolCalls?: number;
    groundingUnavailable?: number;
    lastTurnLatencyMs?: number | null;
}

/**
 * Record one AI request's usage: upserts the user's monthly `usage_periods`
 * rollup AND appends a `request_logs` audit row. Both writes are best-effort
 * (errors are logged, never thrown) so a metering failure can't break the AI
 * response the user already received. Cost is `estimateCost(model, in, out)`;
 * a model missing from the catalog costs $0 (and is logged upstream as a bug).
 */
export async function recordUsage(
    db: D1Database,
    userId: number,
    model: string,
    inputTokens: number,
    outputTokens: number,
    durationMs: number,
    extras: UsageExtras = {},
): Promise<void> {
    const cost = estimateCost(model, inputTokens, outputTokens);
    const periodStart = getCurrentPeriodStart();
    await Promise.all([
        upsertUsagePeriod(db, userId, periodStart, getNextPeriodStart(), inputTokens, outputTokens, cost)
            .catch(err => console.error('Failed to log usage period:', err)),
        createRequestLog(db, {
            userId, model, inputTokens, outputTokens,
            costUsd: cost, durationMs, ...extras,
        }).catch(err => console.error('Failed to log request:', err)),
    ]);
}
