// Shared AI-usage metering. Every AI route (chat, embeddings, graph enrich,
// unity search) funnels its per-request token counts through here so that
// `request_logs` + `usage_periods` reflect ALL neuron spend — not just chat.
// Cost is derived from the model's catalog rate (see costs.ts). Historically
// only chat.ts wrote usage; embeddings/graph/unity burned neurons but recorded
// $0, under-counting real cost and (later) credit consumption.
import { estimateCost } from './costs.ts';
import { upsertUsagePeriod, createRequestLog, getCurrentPeriodStart, getNextPeriodStart, debitCredits } from './db.ts';
import { usdToMicro, GATEWAY_FEE, MARGIN } from '../config/tiers.ts';

/**
 * What the user is charged, in integer micro-USD: the model's list cost,
 * uplifted by Cloudflare's gateway fee and the platform margin. Exported so
 * the arithmetic is testable independently of D1.
 */
export function billedMicro(
    model: string, inputTokens: number, outputTokens: number, cachedTokens = 0,
): number {
    const list = estimateCost(model, inputTokens, outputTokens, cachedTokens);
    return usdToMicro(list * GATEWAY_FEE * MARGIN);
}

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
    /** Actual serving model when a provider fallback fired (non-null ⇒ fallback). */
    fallbackModel?: string;
    /** Inline completions: meter tokens but never debit credits (allowance model). */
    skipDebit?: boolean;
}

/**
 * Record one AI request's usage: upserts the user's monthly `usage_periods`
 * rollup, appends a `request_logs` audit row, AND debits the request's cost
 * from the user's credit balance. All three writes are best-effort (errors are
 * logged, never thrown) so a metering/debit failure can't break the AI response
 * the user already received. Cost is `estimateCost(model, in, out)`; a model
 * missing from the catalog costs $0 (logged upstream as a bug) and is not
 * debited. Debit is `estimateCost x GATEWAY_FEE x MARGIN` — margin lives here, per
 * request, so an upstream price change moves it automatically.
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
    const cachedTokens = extras.cachedInputTokens ?? 0;
    const cost = estimateCost(model, inputTokens, outputTokens, cachedTokens);
    const micro = billedMicro(model, inputTokens, outputTokens, cachedTokens);
    const periodStart = getCurrentPeriodStart();
    const { skipDebit, ...logExtras } = extras;
    await Promise.all([
        upsertUsagePeriod(db, userId, periodStart, getNextPeriodStart(), inputTokens, outputTokens, cost)
            .catch(err => console.error('Failed to log usage period:', err)),
        createRequestLog(db, {
            userId, model, inputTokens, outputTokens,
            costUsd: cost, durationMs, ...logExtras,
        }).catch(err => console.error('Failed to log request:', err)),
        micro > 0 && !skipDebit
            ? debitCredits(db, userId, micro).catch(err => console.error('Failed to debit credits:', err))
            : Promise.resolve(),
    ]);
}
