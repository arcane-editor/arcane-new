import { streamText, jsonSchema } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ModelMessage, ToolSet } from 'ai';
import type { ChatCompletionRequest, ChatMessage, StreamEvent, ToolDefinition } from '../types.ts';
import { getMaxOutput, wireFormatForNativeId, MODEL_CATALOG, type ModelInfo } from '../lib/costs.ts';

// All models — Workers AI catalog ids and unified-billing third-party ids
// alike — route through Cloudflare Workers AI via the AI Gateway (the `AI`
// binding + a gateway id — no provider API key needed). The id prefix is the
// only difference; the binding handles routing either way.
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
//
// `providers: [openaiWire]` registers the response parser for every
// OpenAI-wire unified-billing catalog slug (`openai/…`, `xai/…`, plus the
// long tail). This is workers-ai-provider's stock openai plugin EXCEPT for
// one branch: Cloudflare's run catalog serves the GPT-5.6 family ONLY in
// Responses-API format (the dashboard model page lists "Request formats:
// responses"; a Chat-Completions body gets AiGatewayError 7003 "Invalid
// value at input" — root-caused 2026-08-15 when gpt-5.6-luna 400'd on every
// request while gpt-5.4/5.1/grok validated). Everything else stays on
// `.chat()`, which the catalog serves for the rest of the OpenAI-wire tail.
const openaiWire = {
    wireFormat: 'openai' as const,
    create: ({ modelId, fetch, baseURL }: { modelId: string; fetch: typeof globalThis.fetch; baseURL?: string }) => {
        const provider = createOpenAI({ apiKey: 'unused', fetch, ...(baseURL ? { baseURL } : {}) });
        // The catalog (costs.ts `wireFormat`) is authoritative; the family
        // heuristic only covers uncataloged ids (ad-hoc probes).
        const format = wireFormatForNativeId(modelId)
            ?? (modelId.startsWith('gpt-5.6') ? 'responses' : 'chat');
        return format === 'responses' ? provider.responses(modelId) : provider.chat(modelId);
    },
};

export function workersAiProvider(env: WorkersAiEnv, gatewayOverrides?: GatewayOverrides) {
    return createWorkersAI({
        binding: env.AI,
        providers: [openaiWire],
        ...(env.CF_AI_GATEWAY_ID ? { gateway: { id: env.CF_AI_GATEWAY_ID, ...(gatewayOverrides ?? {}) } } : {}),
    });
}

// 'direct' route (MODEL_CATALOG): a third-party OpenAI-compatible provider
// called with the owner's OWN key, no Cloudflare in the path at all — not
// Workers AI, not the AI Gateway. Spark is the first (and so far only)
// tenant of this path.
export interface SparkEnv {
    SPARK_BASE_URL?: string;
    SPARK_API_KEY?: string;
}

export type LlmEnv = WorkersAiEnv & SparkEnv;

/** Configuration (not model) failure: a required binding/secret is unset. */
export class LlmConfigError extends Error {}

const SPARK_PREFIX = 'spark/';

export function resolveModel(
    modelId: string,
    env: LlmEnv,
    gatewayOverrides?: GatewayOverrides,
    modelSettings?: Record<string, unknown>,
) {
    if (modelId.startsWith(SPARK_PREFIX)) {
        // No CF AI Gateway in this path, so none of the gateway-shaped knobs
        // apply: `gatewayOverrides.skipCache` has nothing to skip-cache
        // (there's no gateway response-replay cache to begin with), and the
        // `@cf/`-only sessionAffinity / `openai/`-only promptCacheKey model
        // settings never reach here (both callers below already gate on
        // those exact prefixes, and `spark/` matches neither — see
        // streamCompletion). Provider-side prompt-prefix caching is still
        // possible (opportunistic, same as xAI today): if Spark's backend
        // reports cached tokens in its OpenAI-compatible usage details, the
        // AI SDK surfaces them as `totalUsage.inputTokenDetails.cacheReadTokens`
        // — the exact field streamCompletion already reads into
        // `cached_input_tokens` — so billing picks them up with no extra
        // wiring, the same as every other route.
        if (!env.SPARK_BASE_URL) throw new LlmConfigError('SPARK_BASE_URL is not set');
        if (!env.SPARK_API_KEY) throw new LlmConfigError('SPARK_API_KEY secret is not set');
        // `includeUsage` verified against the installed
        // @ai-sdk/openai-compatible@2.0.30 type defs: it's a
        // provider-FACTORY option (OpenAICompatibleProviderSettings), not a
        // per-call one. It appends `stream_options: {include_usage: true}`
        // to the streamed request so the OpenAI-compatible chunk stream ends
        // with a usage chunk — without it, streaming responses carry no
        // usage at all and the `finish` event below would see zeroes.
        const provider = createOpenAICompatible({
            name: 'spark',
            baseURL: env.SPARK_BASE_URL,
            apiKey: env.SPARK_API_KEY,
            includeUsage: true,
        });
        return provider(modelId.slice(SPARK_PREFIX.length));
    }
    // Workers AI and unified-billing third-party models both resolve through
    // the AI binding — the id prefix is the only difference and the binding
    // handles routing. `modelSettings` reaches the model constructor (e.g.
    // `sessionAffinity` → the `x-session-affinity` header Workers AI's prefix
    // cache uses to route related requests to the same cache shard).
    return workersAiProvider(env, gatewayOverrides)(modelId, modelSettings);
}

/**
 * Flatten a message's content to text.
 *
 * `content` can legally be `null` — that's OpenAI's convention for an assistant
 * turn carrying no text (only tool calls, only reasoning, or cut short), and the
 * editor emits exactly that (`openai-format.ts`: `textParts || null`). Because
 * `typeof null === 'object'`, a bare `typeof x === 'string' ? … : x.filter(…)`
 * sends null down the array branch and throws. Every content read goes through
 * here so that can't happen again.
 */
function contentText(content: ChatMessage['content'], separator = ''): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter(p => p.type === 'text').map(p => p.text ?? '').join(separator);
}

// workers-ai-provider tags @cf tool-call ids with this marker for its own
// stream bookkeeping (`createAISDKToolCallId`) and strips it again ONLY when
// replaying to a @cf model. The openai wire path forwards ids verbatim, and
// OpenAI validates call ids against ^[a-zA-Z0-9_-]+$ — so a glm turn replayed
// to gpt-5.6-luna 400'd every send ("Bad Request", incident 2026-08-15 #2:
// plan-on-deepthink made glm→luna history the NORMAL plan-mode flow).
const WAI_TOOL_CALL_MARKER = '::cf-wai-tool-call::';

/**
 * Normalize a replayed tool-call id for cross-model safety. Deterministic
 * (same input → same output, so provider prompt caches stay stable) and
 * applied identically to `tool-call` and `tool-result` parts so pairs keep
 * matching. Already-valid ids pass through byte-identical.
 */
function sanitizeToolCallId(id: string): string {
    const mi = id.lastIndexOf(WAI_TOOL_CALL_MARKER);
    const unmarked = mi === -1
        ? id
        // The prefix is the model's own id; the suffix is the provider nonce.
        // Prefer the prefix (matches what @cf models themselves see after the
        // provider's own strip); a bare marker keeps the nonce instead.
        : (id.slice(0, mi) || `tc_${id.slice(mi + WAI_TOOL_CALL_MARKER.length)}`);
    return (unmarked.replace(/[^a-zA-Z0-9_-]/g, '_') || 'tc_0').slice(0, 64);
}

export function convertMessages(messages: ChatMessage[]): ModelMessage[] {
    const result: ModelMessage[] = [];

    for (const msg of messages) {
        if (msg.role === 'system') {
            result.push({ role: 'system', content: contentText(msg.content, '\n') });
        } else if (msg.role === 'user') {
            if (typeof msg.content === 'string' || !Array.isArray(msg.content)) {
                result.push({ role: 'user', content: contentText(msg.content) });
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
                        toolCallId: sanitizeToolCallId(tc.id),
                        toolName: tc.function.name,
                        input: JSON.parse(tc.function.arguments),
                    });
                }
                result.push({ role: 'assistant', content: parts });
            } else {
                result.push({ role: 'assistant', content: contentText(msg.content) });
            }
        } else if (msg.role === 'tool') {
            const text = typeof msg.content === 'string'
                ? msg.content
                : msg.content == null ? '' : JSON.stringify(msg.content);
            result.push({
                role: 'tool',
                content: [{
                    type: 'tool-result',
                    toolCallId: sanitizeToolCallId(msg.tool_call_id!),
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

export type StreamErrorCode = 'rate_limit' | 'model_error';

/**
 * Stream-error message with the upstream detail attached. `String(error)` on
 * an AI SDK APICallError yields just "AI_APICallError: Bad Request" — the
 * status code and provider response body (which name the offending field) are
 * separate properties, and dropping them cost a full debugging session in the
 * 2026-08-15 tool-call-id incident. The enriched message flows into
 * logChatError (Workers Logs) and the editor's surfaced error alike.
 */
export function describeStreamError(error: unknown): string {
    const e = (typeof error === 'object' && error !== null ? error : {}) as {
        statusCode?: number;
        responseBody?: string;
    };
    const status = typeof e.statusCode === 'number' ? ` [status ${e.statusCode}]` : '';
    const body = typeof e.responseBody === 'string' && e.responseBody
        ? ` — upstream: ${e.responseBody.slice(0, 300)}`
        : '';
    return `${String(error)}${status}${body}`;
}

// Workers AI binding errors are normalized by workers-ai-provider into an
// APICallError whose `statusCode` carries the mapped HTTP status (internal
// codes 3036/3040 -> 429), so check that first — the stringified message
// never contains "429".
export function classifyStreamError(error: unknown): StreamErrorCode {
    const status = typeof error === 'object' && error !== null
        ? (error as { statusCode?: number }).statusCode
        : undefined;
    if (status === 429) return 'rate_limit';
    return /rate limit|\b3036\b|\b3040\b|capacity/i.test(String(error)) ? 'rate_limit' : 'model_error';
}

type StreamTextFn = typeof streamText;

export async function* streamCompletion(
    req: ChatCompletionRequest, env: LlmEnv, streamTextImpl: StreamTextFn = streamText,
    signal?: AbortSignal, catalog: Record<string, ModelInfo> = MODEL_CATALOG,
): AsyncGenerator<StreamEvent> {
    // `skipCache` disables the AI GATEWAY's exact-match response-replay cache
    // (a cached replay of a temperature-sampled completion is semantically
    // wrong). It has nothing to do with PROVIDER prompt-prefix caching below,
    // which discounts repeated prompt prefixes without replaying responses.
    //
    // Provider prefix-cache routing hints, keyed by the editor conversation id
    // (metadata.sessionId): Workers AI models take `x-session-affinity` via
    // model settings; OpenAI's GPT-5.6 family wants `prompt_cache_key` in the
    // request body for reliable cache-shard routing. Both are best-effort —
    // caching still works opportunistically without them. xAI's chat
    // completions hint is a header the gateway path doesn't expose today, so
    // grok relies on opportunistic prefix matching.
    const cacheKey = req.metadata?.sessionId;
    const model = resolveModel(
        req.model, env, { skipCache: true },
        cacheKey && req.model.startsWith('@cf/') ? { sessionAffinity: cacheKey } : undefined,
    );
    const messages = convertMessages(req.messages);
    const tools = convertTools(req.tools);
    const maxOutputTokens = Math.min(req.max_tokens ?? 8192, getMaxOutput(req.model, catalog));

    const result = streamTextImpl({
        model, messages, ...(tools ? { tools } : {}),
        // 'none' keeps the tools block in the prompt (cached prefix) while
        // forbidding tool calls — the editor's turn governor sends it at the
        // per-send call cap.
        ...(req.tool_choice === 'none' ? { toolChoice: 'none' as const } : {}),
        ...(cacheKey && req.model.startsWith('openai/')
            ? { providerOptions: { openai: { promptCacheKey: cacheKey } } }
            : {}),
        // Client Stop/disconnect: without this the provider drained (and
        // billed) the full generation after the user stopped reading.
        ...(signal ? { abortSignal: signal } : {}),
        maxOutputTokens, temperature: req.temperature,
    });

    for await (const part of result.fullStream) {
        switch (part.type) {
            case 'text-delta':
                yield { type: 'text', content: part.text };
                break;
            case 'tool-call':
                yield {
                    type: 'tool_call', id: part.toolCallId, name: part.toolName,
                    arguments: JSON.stringify(part.input), finished: true,
                };
                break;
            case 'finish':
                yield {
                    type: 'usage',
                    // The model actually served (post-routing) — lets the
                    // editor surface what ran without trusting its request.
                    model: req.model,
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
                yield { type: 'thinking', thought: part.text, signature: '' };
                break;
            case 'error':
                yield { type: 'error', code: classifyStreamError(part.error), message: describeStreamError(part.error) };
                break;
        }
    }
}
