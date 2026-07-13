import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ChatCompletionRequest, AppEnv } from '../types.ts';
import { streamCompletion } from '../services/llm-router.ts';
import { estimateCost } from '../lib/costs.ts';
import { getIntensityConfig } from '../config/plans.ts';
import { upsertUsagePeriod, createRequestLog, getCurrentPeriodStart, getNextPeriodStart, getHourlyCost } from '../lib/db.ts';
import { logChatError } from '../lib/log.ts';
import type { AuthPayload } from '../middleware/auth.ts';

export const chatRouter = new Hono<AppEnv>();

const HOURLY_LIMIT_USD = 1.00;

function resolveModelFromRequest(body: ChatCompletionRequest): string {
    // Model choice is 100% backend: the editor sends an abstract reasoningLevel
    // and we map it to a concrete Workers AI model id here.
    const intensity = body.metadata?.reasoningLevel;
    if (intensity) {
        const config = getIntensityConfig(intensity);
        if (config) {
            return config.model;
        }
    }

    // Safe fallback so a missing/garbage level never sends a non-catalog id
    // to the gateway. (The editor never sends a raw model id anymore.)
    return getIntensityConfig('mid')!.model;
}

async function checkHourlyLimit(db: D1Database, userId: number): Promise<{ allowed: true } | { allowed: false; costUsd: number; resetsAt: string; resetsInSeconds: number }> {
    const { totalCost, oldestTimestamp } = await getHourlyCost(db, userId);

    if (totalCost < HOURLY_LIMIT_USD) {
        return { allowed: true };
    }

    // Calculate when the oldest request in the window ages out (oldest_ts + 1 hour)
    let resetsAt: string;
    let resetsInSeconds: number;
    if (oldestTimestamp) {
        const resetTime = new Date(new Date(oldestTimestamp).getTime() + 60 * 60 * 1000);
        resetsAt = resetTime.toISOString();
        resetsInSeconds = Math.max(0, Math.ceil((resetTime.getTime() - Date.now()) / 1000));
    } else {
        // Fallback: reset in 1 hour from now
        resetsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        resetsInSeconds = 3600;
    }

    return { allowed: false, costUsd: totalCost, resetsAt, resetsInSeconds };
}

async function logUsage(
    db: D1Database, user: AuthPayload, model: string,
    inputTokens: number, outputTokens: number, durationMs: number,
    extras: {
        taskType?: string; turnIndex?: number; toolErrorCount?: number; repairCount?: number; cachedInputTokens?: number;
        groundingLintHits?: number; loopGuardHits?: number; escalated?: boolean;
        groundingToolCalls?: number; groundingUnavailable?: number; lastTurnLatencyMs?: number | null;
    },
): Promise<void> {
    const cost = estimateCost(model, inputTokens, outputTokens);
    const periodStart = getCurrentPeriodStart();
    await Promise.all([
        upsertUsagePeriod(db, parseInt(user.sub), periodStart, getNextPeriodStart(), inputTokens, outputTokens, cost)
            .catch(err => console.error('Failed to log usage period:', err)),
        createRequestLog(db, {
            userId: parseInt(user.sub), model, inputTokens, outputTokens,
            costUsd: cost, durationMs, ...extras,
        }).catch(err => console.error('Failed to log request:', err)),
    ]);
}

chatRouter.post('/v1/chat/completions', async (c) => {
    const body = await c.req.json<ChatCompletionRequest>();
    const user = c.get('user') as AuthPayload;

    // Check hourly spending limit
    const budgetCheck = await checkHourlyLimit(c.env.arcane_db, parseInt(user.sub));
    if (!budgetCheck.allowed) {
        return c.json({
            error: `You've used all your credits. Resets in ~${Math.ceil(budgetCheck.resetsInSeconds / 60)} minutes (${new Date(budgetCheck.resetsAt).toLocaleTimeString()}).`,
        }, 429);
    }

    // Resolve model
    const model = resolveModelFromRequest(body);
    if (c.env.ENVIRONMENT === 'development') {
        console.log(`[chat] user=${user.sub} requested="${body.model}" resolved="${model}"`);
    }
    body.model = model;

    const startTime = Date.now();
    const env = c.env;
    // Shared context for structured error logs (body.model is already resolved).
    const errCtx = { userId: user.sub, model: body.model, reasoningLevel: body.metadata?.reasoningLevel, taskType: body.metadata?.taskType };

    if (!body.stream) {
        try {
            let content = '';
            const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
            let inputTokens = 0;
            let outputTokens = 0;
            let cachedInputTokens = 0;

            for await (const event of streamCompletion(body, env)) {
                if (event.type === 'text') content += event.content;
                if (event.type === 'tool_call') toolCalls.push({ id: event.id, name: event.name, arguments: event.arguments });
                if (event.type === 'usage') {
                    inputTokens = event.input_tokens;
                    outputTokens = event.output_tokens;
                    cachedInputTokens = event.cached_input_tokens ?? 0;
                }
                // Surface upstream errors instead of silently returning empty content.
                if (event.type === 'error') throw new Error(event.message);
            }

            const durationMs = Date.now() - startTime;
            await logUsage(env.arcane_db, user, body.model, inputTokens, outputTokens, durationMs, {
                taskType: body.metadata?.taskType,
                turnIndex: body.metadata?.telemetry?.turnIndex,
                toolErrorCount: body.metadata?.telemetry?.toolErrorCount,
                repairCount: body.metadata?.telemetry?.repairCount,
                cachedInputTokens,
                groundingLintHits: body.metadata?.telemetry?.groundingLintHits,
                loopGuardHits: body.metadata?.telemetry?.loopGuardHits,
                escalated: body.metadata?.telemetry?.escalated,
                groundingToolCalls: body.metadata?.telemetry?.groundingToolCalls,
                groundingUnavailable: body.metadata?.telemetry?.groundingUnavailable,
                lastTurnLatencyMs: body.metadata?.telemetry?.lastTurnLatencyMs,
            });

            return c.json({
                id: `chatcmpl-${crypto.randomUUID()}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: body.model,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: content || null,
                        ...(toolCalls.length > 0 ? {
                            tool_calls: toolCalls.map((tc, i) => ({
                                id: tc.id, index: i, type: 'function',
                                function: { name: tc.name, arguments: tc.arguments },
                            })),
                        } : {}),
                    },
                    finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
                }],
                usage: {
                    prompt_tokens: inputTokens,
                    completion_tokens: outputTokens,
                    total_tokens: inputTokens + outputTokens,
                },
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logChatError(errCtx, 'chat.nonstream.catch', message);
            return c.json({ error: { message, type: 'server_error' } }, 500);
        }
    }

    // Streaming: SSE with StreamEvent format
    return streamSSE(c, async (stream) => {
        let inputTokens = 0;
        let outputTokens = 0;
        let cachedInputTokens = 0;

        try {
            for await (const event of streamCompletion(body, env)) {
                if (event.type === 'usage') {
                    inputTokens = event.input_tokens;
                    outputTokens = event.output_tokens;
                    cachedInputTokens = event.cached_input_tokens ?? 0;
                }
                if (event.type === 'error') {
                    logChatError(errCtx, 'chat.stream.forward', event.message);
                }
                await stream.writeSSE({ data: JSON.stringify(event) });
            }
            await stream.writeSSE({ data: '[DONE]' });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logChatError(errCtx, 'chat.stream.catch', message);
            await stream.writeSSE({
                data: JSON.stringify({ type: 'error', code: 'server_error', message }),
            });
        } finally {
            const durationMs = Date.now() - startTime;
            await logUsage(env.arcane_db, user, body.model, inputTokens, outputTokens, durationMs, {
                taskType: body.metadata?.taskType,
                turnIndex: body.metadata?.telemetry?.turnIndex,
                toolErrorCount: body.metadata?.telemetry?.toolErrorCount,
                repairCount: body.metadata?.telemetry?.repairCount,
                cachedInputTokens,
                groundingLintHits: body.metadata?.telemetry?.groundingLintHits,
                loopGuardHits: body.metadata?.telemetry?.loopGuardHits,
                escalated: body.metadata?.telemetry?.escalated,
                groundingToolCalls: body.metadata?.telemetry?.groundingToolCalls,
                groundingUnavailable: body.metadata?.telemetry?.groundingUnavailable,
                lastTurnLatencyMs: body.metadata?.telemetry?.lastTurnLatencyMs,
            });
        }
    });
});
