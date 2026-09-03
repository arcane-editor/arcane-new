import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ChatCompletionRequest, AppEnv } from '../types.ts';
import { streamCompletion } from '../services/llm-router.ts';
import { DEFAULT_INTENSITY, getIntensityConfig } from '../config/plans.ts';
import { resolveModelForSend } from '../config/routing.ts';
import { isTierAllowed, minPlanForTier, TIERS } from '../config/tiers.ts';
import { checkAiBudget } from '../lib/credits.ts';
import { getUserBillingRow } from '../lib/db.ts';
import { getModelRouting, getEffectivePricing } from '../lib/app-config.ts';
import { recordUsage } from '../lib/usage.ts';
import { logChatError } from '../lib/log.ts';
import { startHeartbeat, SSE_HEARTBEAT_FRAME } from '../lib/sse-heartbeat.ts';
import type { AuthPayload } from '../middleware/auth.ts';

export const chatRouter = new Hono<AppEnv>();

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
    const userId = parseInt(user.sub);

    // Effort-tier gate: Deep Think ('mid') and Max ('high'/'super') are paid
    // features. This is the single place the requested tier is resolved —
    // both the gate and model resolution below consume it, so a free user
    // sending no level can never be gated on one tier and billed/resolved on
    // another. Runs before checkAiBudget/the model call so a rejected
    // request costs nothing.
    const requestedTier = body.metadata?.reasoningLevel ?? DEFAULT_INTENSITY;
    const billing = await getUserBillingRow(c.env.arcane_db, userId);
    const plan = billing?.plan ?? 'free';
    if (!isTierAllowed(plan, requestedTier)) {
        const requiredPlan = minPlanForTier(requestedTier);
        const featureLabel = getIntensityConfig(requestedTier)?.label ?? 'This feature';
        return c.json({
            error: `${featureLabel} requires the ${TIERS[requiredPlan].name} plan.`,
            code: 'tier_not_available',
            requiredPlan,
        }, 403);
    }

    // Credit balance + anti-abuse hourly cap. 402 = out of credits (upgrade /
    // top up); 429 = short-window rate limit.
    const budget = await checkAiBudget(c.env.arcane_db, userId);
    if (!budget.ok) return c.json({ error: budget.error, code: budget.code }, budget.status);

    // Resolve model — config-driven routing (config/routing.ts against the
    // runtime `model_routing` doc, lib/app-config.ts). Model choice is 100%
    // backend: the editor sends an abstract reasoningLevel + routing signals;
    // the concrete model id is chosen here against the already-gated tier, so
    // the isTierAllowed gate above stays authoritative for what was REQUESTED.
    const routingDoc = await getModelRouting(c.env.arcane_db);
    const decision = resolveModelForSend(
        requestedTier,
        {
            taskType: body.metadata?.taskType,
            planPhase: body.metadata?.planPhase,
            difficulty: body.metadata?.difficulty,
        },
        routingDoc,
    );

    // Serve guard: a routing doc (or the code-default fallback) can only be
    // trusted once cross-checked against the EFFECTIVE pricing catalog — a
    // model missing from it would otherwise bill $0 (see usage.ts) and stream
    // through a provider call that's not accounted for anywhere.
    const pricing = await getEffectivePricing(c.env.arcane_db);
    if (!pricing.catalog[decision.model]) {
        console.error(JSON.stringify({ event: 'model_unconfigured', model: decision.model }));
        return c.json({ error: 'This model is not configured. Contact support.', code: 'model_unconfigured' }, 503);
    }

    if (c.env.ENVIRONMENT === 'development') {
        console.log(`[chat] user=${user.sub} tier="${requestedTier}" resolved="${decision.model}" routedTier="${decision.routedTier}" reason=${decision.reason} effort=${decision.effort ?? 'none'}`);
    }
    body.model = decision.model;
    // Effort travels as an ARGUMENT to streamCompletion, not on `body` — a
    // client-sent field can therefore never reach the provider, the way
    // `body.model` is overwritten above.
    const effort = decision.effort;

    const startTime = Date.now();
    const env = c.env;
    // Shared context for structured error logs (body.model is already resolved).
    const errCtx = { userId: user.sub, model: body.model, reasoningLevel: body.metadata?.reasoningLevel, taskType: body.metadata?.taskType };

    if (!body.stream) {
        let content = '';
        const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
        let inputTokens = 0;
        let outputTokens = 0;
        let cachedInputTokens = 0;
        let sawUsage = false;
        try {
            for await (const event of streamCompletion(body, env, undefined, undefined, pricing.catalog, effort)) {
                if (event.type === 'text') content += event.content;
                if (event.type === 'tool_call') toolCalls.push({ id: event.id, name: event.name, arguments: event.arguments });
                if (event.type === 'usage') {
                    inputTokens = event.input_tokens;
                    outputTokens = event.output_tokens;
                    cachedInputTokens = event.cached_input_tokens ?? 0;
                    sawUsage = true;
                }
                // Surface upstream errors instead of silently returning empty content.
                if (event.type === 'error') throw new Error(event.message);
            }

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
                    // OpenAI-compatible cached-prefix detail — consumed by the
                    // eval harness's cache-share metric (eval-stream.ts).
                    prompt_tokens_details: { cached_tokens: cachedInputTokens },
                },
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logChatError(errCtx, 'chat.nonstream.catch', message);
            return c.json({ error: { message, type: 'server_error' } }, 500);
        } finally {
            // Metering must run on the ERROR path too: the throw above used to
            // jump past logUsage entirely — real provider spend recorded as
            // NOTHING, invisible to the debit and the $1/hr anti-abuse cap.
            // When the provider died before its finish event, estimate from
            // what actually streamed.
            if (!sawUsage && (content.length > 0 || toolCalls.length > 0)) {
                outputTokens = Math.ceil(
                    (content.length + toolCalls.reduce((n, tc) => n + tc.arguments.length, 0)) / 4,
                );
                inputTokens = Math.ceil(JSON.stringify(body.messages ?? []).length / 4);
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
        }
    }

    // Streaming: SSE with StreamEvent format
    const sseResponse = streamSSE(c, async (stream) => {
        let inputTokens = 0;
        let outputTokens = 0;
        let cachedInputTokens = 0;
        let sawUsage = false;
        let streamedChars = 0;
        // Client Stop/disconnect aborts this signal; forwarding it into
        // streamCompletion cancels the provider call instead of draining
        // (and billing) the full post-Stop generation. Hono's writeSSE
        // swallows dead-writer errors, so the signal — not a write failure —
        // is the only reliable disconnect notification.
        const clientSignal = c.req.raw.signal;

        // Keepalive (see lib/sse-heartbeat.ts for the full why). `streamSSE`
        // already handed the client its response headers, and the editor
        // starts a first-token watchdog off them — but nothing is written
        // here until the model emits its first event, so that watchdog was
        // timing model latency and killing slow turns with "Stream stalled
        // before the first token". This first frame proves the connection
        // immediately; the timer keeps proving it while the model thinks.
        await stream.write(SSE_HEARTBEAT_FRAME);

        // Because heartbeats make the client watchdogs unable to distinguish
        // "still thinking" from "provider dead", the real liveness check
        // moves here: no upstream event for UPSTREAM_STALL_TIMEOUT_MS aborts
        // the provider call, which unwinds into the catch below as a visible
        // error rather than an open connection nobody is ever going to close.
        const upstreamStall = new AbortController();
        const heartbeat = startHeartbeat({
            write: (frame) => {
                if (stream.closed || stream.aborted || clientSignal.aborted) return;
                void stream.write(frame);
            },
            onStall: (idleMs) => upstreamStall.abort(
                new Error(`upstream produced no events for ${idleMs}ms`),
            ),
        });

        try {
            const upstreamSignal = AbortSignal.any([clientSignal, upstreamStall.signal]);
            for await (const event of streamCompletion(body, env, undefined, upstreamSignal, pricing.catalog, effort)) {
                heartbeat.sawEvent();
                if (event.type === 'text') streamedChars += event.content.length;
                if (event.type === 'tool_call') streamedChars += event.arguments.length;
                if (event.type === 'usage') {
                    inputTokens = event.input_tokens;
                    outputTokens = event.output_tokens;
                    cachedInputTokens = event.cached_input_tokens ?? 0;
                    sawUsage = true;
                }
                if (event.type === 'error') {
                    logChatError(errCtx, 'chat.stream.forward', event.message);
                }
                if (clientSignal.aborted) break; // dead writer — stop pulling upstream
                await stream.writeSSE({ data: JSON.stringify(event) });
            }
            await stream.writeSSE({ data: '[DONE]' });
        } catch (err) {
            // An abort surfaces as a throw from the AI SDK. Which abort it
            // was decides everything: the client's Stop is the expected happy
            // path (silent), ours is a dead provider the user must be told
            // about — and telling them is the whole point of the stall cap,
            // since heartbeats have taken that job away from the client.
            if (upstreamStall.signal.aborted) {
                const message = 'The model stopped responding before producing any output. Please try again.';
                logChatError(errCtx, 'chat.stream.upstream_stall', message);
                await stream.writeSSE({
                    data: JSON.stringify({ type: 'error', code: 'server_error', message }),
                });
            } else if (!clientSignal.aborted) {
                const message = err instanceof Error ? err.message : String(err);
                logChatError(errCtx, 'chat.stream.catch', message);
                await stream.writeSSE({
                    data: JSON.stringify({ type: 'error', code: 'server_error', message }),
                });
            }
        } finally {
            heartbeat.stop();
            // Aborted/errored streams end with no 'finish' part, so usage was
            // metered as 0x0 — the delivered tokens were free and invisible
            // to the $1/hr cap. Estimate from what actually streamed.
            if (!sawUsage && streamedChars > 0) {
                outputTokens = Math.ceil(streamedChars / 4);
                inputTokens = Math.ceil(JSON.stringify(body.messages ?? []).length / 4);
            }
            const durationMs = Date.now() - startTime;
            // waitUntil: on client disconnect the runtime can tear this
            // handler down mid-write — the debit and the request_logs row
            // feeding the hourly cap must survive it (same pattern
            // auth-email.ts uses for its verification send).
            c.executionCtx.waitUntil(logUsage(env.arcane_db, user, body.model, inputTokens, outputTokens, durationMs, {
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
            }));
        }
    });

    // Keep the keepalive frames actually reaching the client. `streamSSE`
    // sets Content-Type/Cache-Control itself, so these have to be applied to
    // the finished Response rather than through `c.header()` (which it
    // overwrites). Both headers exist to stop an intermediary from holding
    // small writes back:
    //  - `no-transform` tells Cloudflare not to compress the stream. A gzip
    //    encoder buffers until it has a block worth emitting, which is
    //    exactly how a 13-byte heartbeat becomes invisible.
    //  - `X-Accel-Buffering: no` is the de-facto opt-out honoured by nginx
    //    and other reverse proxies users sit behind (corporate egress and
    //    TLS-inspecting security software, disproportionately on Windows).
    // Neither is load-bearing for correctness on a clean network; both are
    // what makes the heartbeat dependable on a dirty one.
    sseResponse.headers.set('Cache-Control', 'no-cache, no-transform');
    sseResponse.headers.set('X-Accel-Buffering', 'no');
    return sseResponse;
});
