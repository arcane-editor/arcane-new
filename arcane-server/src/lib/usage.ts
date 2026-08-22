// Shared AI-usage metering. Every AI route (chat, embeddings, graph enrich,
// unity search) funnels its per-request token counts through here so that
// `request_logs` + `usage_periods` reflect ALL neuron spend — not just chat.
// Cost is derived from the model's catalog rate (see costs.ts). Historically
// only chat.ts wrote usage; embeddings/graph/unity burned neurons but recorded
// $0, under-counting real cost and (later) credit consumption.
import { estimateCost, MODEL_CATALOG } from './costs.ts';
import { upsertUsagePeriod, createRequestLog, getCurrentPeriodStart, getNextPeriodStart, debitCredits } from './db.ts';
import { usdToMicro, GATEWAY_FEE, MARGIN } from '../config/tiers.ts';
import { getEffectivePricing, type EffectivePricing } from './app-config.ts';

/**
 * What the user is charged, in integer micro-USD: the model's list cost,
 * uplifted by Cloudflare's gateway fee (and MARGIN, currently 1.0 — a no-op;
 * margin now lives in plan-grant sizing and the top-up markup, see
 * config/tiers.ts). A `route: 'direct'` model (no Cloudflare in the request
 * path — see costs.ts) never pays the gateway fee. Exported so the arithmetic
 * is testable independently of D1.
 *
 * Pass `pricing` (from app-config.ts's getEffectivePricing) to bill against
 * the admin-overridden catalog/gatewayFee/margin instead of the static
 * defaults; omitting it preserves the exact static behaviour.
 */
export function billedMicro(
    model: string, inputTokens: number, outputTokens: number, cachedTokens = 0,
    pricing?: EffectivePricing,
): number {
    if (pricing) {
        const list = estimateCost(model, inputTokens, outputTokens, cachedTokens, pricing.catalog);
        const fee = pricing.catalog[model]?.route === 'direct' ? 1 : pricing.gatewayFee;
        return usdToMicro(list * fee * pricing.margin);
    }
    const list = estimateCost(model, inputTokens, outputTokens, cachedTokens);
    const fee = MODEL_CATALOG[model]?.route === 'direct' ? 1 : GATEWAY_FEE;
    return usdToMicro(list * fee * MARGIN);
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
 * the user already received. Cost is `estimateCost(model, in, out)` against
 * the EFFECTIVE catalog (app-config.ts's getEffectivePricing — at most one D1
 * read per isolate per 60s); a model missing from it costs $0 (logged
 * upstream as a bug) and is not debited. Debit is
 * `estimateCost x gatewayFee x margin` (gatewayFee waived for a `route:
 * 'direct'` model — see billedMicro above); both default to GATEWAY_FEE/
 * MARGIN (1.0 — a no-op now) absent an admin override.
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
    const pricing = await getEffectivePricing(db);
    const cost = estimateCost(model, inputTokens, outputTokens, cachedTokens, pricing.catalog);
    const micro = billedMicro(model, inputTokens, outputTokens, cachedTokens, pricing);
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
