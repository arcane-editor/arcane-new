import { streamText, jsonSchema } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ModelMessage, ToolSet } from 'ai';
import type { ChatCompletionRequest, ChatMessage, StreamEvent, ToolDefinition } from '../types.ts';
import { getMaxOutput } from '../lib/costs.ts';

// Workers AI catalog models route through Cloudflare Workers AI via the AI
// Gateway (the `AI` binding + a gateway id — no provider API key needed).
// Everything else (custom-provider ids) routes through the AI Gateway's
// unified /compat endpoint — see ExternalRoutingEnv below.
export interface WorkersAiEnv {
    AI: Ai;
    CF_AI_GATEWAY_ID?: string;
}

export interface GatewayOverrides {
    skipCache?: boolean;
}

// Shared provider factory (used by chat, embeddings and graph enrichment). The
// gateway is included only when configured, so a not-yet-created gateway never
// breaks inference — it just loses the gateway's caching/logging until set.
// `gatewayOverrides` lets call sites tune per-request gateway behavior (e.g.
// skipCache for non-deterministic/sampled completions) without affecting the
// no-gateway-configured case, where no `gateway` key is sent at all.
export function workersAiProvider(env: WorkersAiEnv, gatewayOverrides?: GatewayOverrides) {
    return createWorkersAI({
        binding: env.AI,
        ...(env.CF_AI_GATEWAY_ID ? { gateway: { id: env.CF_AI_GATEWAY_ID, ...(gatewayOverrides ?? {}) } } : {}),
    });
}

// External providers (MiniMax, Moonshot) are reached through the AI Gateway's
// unified /compat endpoint using custom-provider slugs. Keys are Worker
// secrets sent per-request as the Authorization header (owner declined BYOK).
export interface ExternalRoutingEnv {
    CF_ACCOUNT_ID?: string;
    MINIMAX_API_KEY?: string;
    MOONSHOT_API_KEY?: string;
}

export type LlmEnv = WorkersAiEnv & ExternalRoutingEnv;

/** Configuration (not model) failure: missing account id / gateway / secret. */
export class LlmConfigError extends Error {}

export function isExternalModel(modelId: string): boolean {
    return !modelId.startsWith('@cf/');
}

export function externalApiKey(modelId: string, env: ExternalRoutingEnv): string {
    if (modelId.startsWith('custom-minimax/')) {
        if (!env.MINIMAX_API_KEY) throw new LlmConfigError('MINIMAX_API_KEY secret is not set');
        return env.MINIMAX_API_KEY;
    }
    if (modelId.startsWith('custom-moonshot/')) {
        if (!env.MOONSHOT_API_KEY) throw new LlmConfigError('MOONSHOT_API_KEY secret is not set');
        return env.MOONSHOT_API_KEY;
    }
    throw new LlmConfigError(`No provider key mapping for model "${modelId}"`);
}

export function gatewayCompatUrl(env: ExternalRoutingEnv & { CF_AI_GATEWAY_ID?: string }): string {
    if (!env.CF_ACCOUNT_ID) throw new LlmConfigError('CF_ACCOUNT_ID is not set');
    if (!env.CF_AI_GATEWAY_ID) throw new LlmConfigError('CF_AI_GATEWAY_ID is not set');
    return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_AI_GATEWAY_ID}/compat`;
}

export function resolveModel(modelId: string, env: LlmEnv, gatewayOverrides?: GatewayOverrides) {
    if (!isExternalModel(modelId)) {
        return workersAiProvider(env, gatewayOverrides)(modelId);
    }
    const provider = createOpenAICompatible({
        name: 'ai-gateway-compat',
        baseURL: gatewayCompatUrl(env),
        apiKey: externalApiKey(modelId, env),
    });
    return provider(modelId);
}

export function convertMessages(messages: ChatMessage[]): ModelMessage[] {
    const result: ModelMessage[] = [];

    for (const msg of messages) {
        if (msg.role === 'system') {
            const text = typeof msg.content === 'string'
                ? msg.content
                : msg.content.filter(p => p.type === 'text').map(p => p.text ?? '').join('\n');
            result.push({ role: 'system', content: text });
        } else if (msg.role === 'user') {
            if (typeof msg.content === 'string') {
                result.push({ role: 'user', content: msg.content });
            } else {
                const parts = msg.content.map(part => {
                    if (part.type === 'text') return { type: 'text' as const, text: part.text ?? '' };
                    if (part.type === 'image_url' && part.image_url) {
                        return { type: 'image' as const, image: part.image_url.url };
                    }
                    return { type: 'text' as const, text: '[unsupported content]' };
                });
                result.push({ role: 'user', content: parts });
            }
        } else if (msg.role === 'assistant') {
            if (msg.tool_calls && msg.tool_calls.length > 0) {
                const parts: Array<{ type: 'text'; text: string } | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }> = [];
                if (typeof msg.content === 'string' && msg.content) {
                    parts.push({ type: 'text', text: msg.content });
                }
                for (const tc of msg.tool_calls) {
                    parts.push({
                        type: 'tool-call',
                        toolCallId: tc.id,
                        toolName: tc.function.name,
                        input: JSON.parse(tc.function.arguments),
                    });
                }
                result.push({ role: 'assistant', content: parts });
            } else {
                const text = typeof msg.content === 'string'
                    ? msg.content
                    : msg.content.filter(p => p.type === 'text').map(p => p.text ?? '').join('');
                result.push({ role: 'assistant', content: text });
            }
        } else if (msg.role === 'tool') {
            const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            result.push({
                role: 'tool',
                content: [{
                    type: 'tool-result',
                    toolCallId: msg.tool_call_id!,
                    toolName: msg.name ?? '',
                    output: { type: 'text', value: text },
                }],
            });
        }
    }

    return result;
}

export function convertTools(tools?: ToolDefinition[]): ToolSet | undefined {
    if (!tools || tools.length === 0) return undefined;
    const toolSet: ToolSet = {};
    for (const t of tools) {
        toolSet[t.function.name] = {
            description: t.function.description,
            inputSchema: jsonSchema(t.function.parameters as any),
            // No execute — gateway pattern: tool calls return to editor for execution
        };
    }
    return toolSet;
}

// Classify a stream error for the SSE `code` field. Workers AI binding errors
// are normalized by workers-ai-provider into an APICallError whose
// `statusCode` carries the mapped HTTP status (internal codes 3036/3040 →
// 429), so check that first — the stringified message never contains "429".
// The message-text fallback covers rate-limit/capacity wording and the raw
// internal codes for errors that escape normalization. External-provider
// (MiniMax/Moonshot, via the gateway /compat endpoint) errors get their own
// provider_* codes so ops can tell "our CF model is rate-limited" apart from
// "the external provider is down/unauthorized/timed out".
export type StreamErrorCode =
    | 'rate_limit' | 'model_error'
    | 'provider_rate_limit' | 'provider_auth_failure' | 'provider_unavailable' | 'gateway_timeout';

export function classifyStreamError(error: unknown, externalModel: boolean): StreamErrorCode {
    const status = typeof error === 'object' && error !== null
        ? (error as { statusCode?: number }).statusCode
        : undefined;
    if (externalModel) {
        if (status === 429) return 'provider_rate_limit';
        if (status === 401 || status === 403) return 'provider_auth_failure';
        if (status !== undefined && status >= 500) return 'provider_unavailable';
        if (/timeout|timed out/i.test(String(error))) return 'gateway_timeout';
        return 'model_error';
    }
    if (status === 429) return 'rate_limit';
    return /rate limit|\b3036\b|\b3040\b|capacity/i.test(String(error)) ? 'rate_limit' : 'model_error';
}

// One-shot CF-catalog fallback per external model, so chat survives a
// MiniMax/Moonshot outage. Keys must exist in MODEL_CATALOG (guard test A1).
const FALLBACK_MODEL: Record<string, string> = {
    'custom-minimax/MiniMax-M3': '@cf/qwen/qwen2.5-coder-32b-instruct',
    'custom-moonshot/kimi-k3':   '@cf/zai-org/glm-5.2',
};

export function fallbackModelFor(modelId: string): string | null {
    return FALLBACK_MODEL[modelId] ?? null;
}

/** 400-class request errors would fail identically anywhere — no fallback.
 *  Everything else (5xx, 429, network/timeout, provider 401/403) falls back. */
export function shouldFallback(error: unknown): boolean {
    const status = typeof error === 'object' && error !== null
        ? (error as { statusCode?: number }).statusCode
        : undefined;
    if (status !== undefined && status >= 400 && status < 500
        && status !== 401 && status !== 403 && status !== 429) return false;
    return true;
}

type StreamTextFn = typeof streamText;

export async function* streamCompletion(
    req: ChatCompletionRequest, env: LlmEnv, streamTextImpl: StreamTextFn = streamText,
): AsyncGenerator<StreamEvent> {
    let modelId = req.model;
    let allowFallback = true;
    // A missing secret / account id is a config failure, not a model failure —
    // fall back immediately (and loudly) instead of 500ing the request.
    try {
        resolveModel(modelId, env, { skipCache: true });
    } catch (err) {
        const fb = err instanceof LlmConfigError ? fallbackModelFor(modelId) : null;
        if (!fb) throw err;
        console.error(JSON.stringify({ event: 'provider_config_fallback', model: modelId, fallback: fb, message: String(err) }));
        yield { type: 'fallback', model: fb };
        modelId = fb;
        allowFallback = false;
    }
    yield* streamOnce(req, modelId, env, allowFallback, streamTextImpl);
}

async function* streamOnce(
    req: ChatCompletionRequest, modelId: string, env: LlmEnv,
    allowFallback: boolean, streamTextImpl: StreamTextFn,
): AsyncGenerator<StreamEvent> {
    // A cached replay of a sampled completion is semantically wrong — chat
    // completions are non-deterministic (temperature-sampled), so bypass the
    // gateway cache for this path.
    const model = resolveModel(modelId, env, { skipCache: true });
    const messages = convertMessages(req.messages);
    const tools = convertTools(req.tools);

    // Clamp output tokens to the model's published cap (Workers AI models vary).
    const cap = getMaxOutput(modelId);
    const maxOutputTokens = Math.min(req.max_tokens ?? 8192, cap);

    const result = streamTextImpl({
        model,
        messages,
        ...(tools ? { tools } : {}),
        maxOutputTokens,
        temperature: req.temperature,
    });

    let yieldedContent = false;
    for await (const part of result.fullStream) {
        switch (part.type) {
            case 'text-delta':
                yieldedContent = true;
                yield { type: 'text', content: part.text };
                break;
            case 'tool-call':
                yieldedContent = true;
                yield {
                    type: 'tool_call',
                    id: part.toolCallId,
                    name: part.toolName,
                    arguments: JSON.stringify(part.input),
                    finished: true,
                };
                break;
            case 'finish':
                yield {
                    type: 'usage',
                    input_tokens: part.totalUsage.inputTokens ?? 0,
                    output_tokens: part.totalUsage.outputTokens ?? 0,
                    // AI SDK v5: `totalUsage.cachedInputTokens` is deprecated in favor
                    // of `inputTokenDetails.cacheReadTokens` (checked against the
                    // installed `ai` package's types). 0/undefined for Workers AI
                    // today — no prefix-caching provider is wired up yet (see
                    // AI-SPEC.md "Prompt caching status") — plumbed through now so
                    // request_logs.cached_input_tokens lights up the day one is.
                    cached_input_tokens: part.totalUsage.inputTokenDetails.cacheReadTokens ?? 0,
                };
                break;
            case 'reasoning-delta':
                yieldedContent = true;
                yield { type: 'thinking', thought: part.text, signature: '' };
                break;
            case 'error': {
                const external = isExternalModel(modelId);
                const fb = fallbackModelFor(modelId);
                if (allowFallback && fb && !yieldedContent && shouldFallback(part.error)) {
                    console.error(JSON.stringify({
                        event: 'provider_fallback', model: modelId, fallback: fb,
                        code: classifyStreamError(part.error, external), message: String(part.error),
                    }));
                    yield { type: 'fallback', model: fb };
                    yield* streamOnce(req, fb, env, false, streamTextImpl);
                    return;
                }
                yield { type: 'error', code: classifyStreamError(part.error, external), message: String(part.error) };
                break;
            }
        }
    }
}
