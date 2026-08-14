import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ChatCompletionRequest, AppEnv } from '../types.ts';
import { streamCompletion } from '../services/llm-router.ts';
import { getIntensityConfig } from '../config/plans.ts';
import { checkAiBudget } from '../lib/credits.ts';
import { recordUsage } from '../lib/usage.ts';
import { logChatError } from '../lib/log.ts';
import type { AuthPayload } from '../middleware/auth.ts';

export const chatRouter = new Hono<AppEnv>();

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

// Chat metering keeps its own thin wrapper so the two call sites below stay
// readable; the shared orchestration (period rollup + request log + cost) lives
// in recordUsage (src/lib/usage.ts), reused by embeddings/graph/unity.
function logUsage(
    db: D1Database, user: AuthPayload, model: string,
    inputTokens: number, outputTokens: number, durationMs: number,
    extras: import('../lib/usage.ts').UsageExtras,
): Promise<void> {
    return recordUsage(db, parseInt(user.sub), model, inputTokens, outputTokens, durationMs, extras);
}

chatRouter.post('/v1/chat/completions', async (c) => {
    const body = await c.req.json<ChatCompletionRequest>();
    const user = c.get('user') as AuthPayload;

    // Credit balance + anti-abuse hourly cap. 402 = out of credits (upgrade /
    // top up); 429 = short-window rate limit.
    const budget = await checkAiBudget(c.env.arcane_db, parseInt(user.sub));
    if (!budget.ok) return c.json({ error: budget.error, code: budget.code }, budget.status);

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
