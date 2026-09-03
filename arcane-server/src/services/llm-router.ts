import { streamText, jsonSchema } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ModelMessage, ToolSet } from 'ai';
import type { ChatCompletionRequest, ChatMessage, StreamEvent, ToolDefinition } from '../types.ts';
import { getMaxOutput, wireFormatForNativeId, MODEL_CATALOG, type ModelInfo } from '../lib/costs.ts';
import type { EffortLevel } from '../config/routing.ts';

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

/** The `name` passed to createOpenAICompatible below AND the id prefix that
 *  selects that route — @ai-sdk/openai-compatible derives its
 *  providerOptions key from the provider name, so the two must stay equal or
 *  `providerOptions.spark` silently stops being read. */
const SPARK_PROVIDER = 'spark';
const SPARK_PREFIX = `${SPARK_PROVIDER}/`;

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
            name: SPARK_PROVIDER,
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

/**
 * Did the provider reject our `tool_choice` field outright? Several
 * OpenAI-compatible endpoints reachable through this router implement only
 * `"auto"` and 400 the whole request on anything else:
 *
 *     only "auto" is supported for tool_choice. "none", "required", and
 *     named function choices are not currently supported
 *
 * We send exactly one value ('none') and only when the editor's turn governor
 * reaches its per-send call cap, so an upstream error naming the field is that
 * disagreement and nothing else. The match is on the FIELD NAME — which every
 * OpenAI-shaped error body repeats in `param` — not on the sentence, so a
 * provider that words the refusal differently is still recognized.
 */
export function isToolChoiceRejection(error: unknown): boolean {
    return /tool_?choice/i.test(describeStreamError(error));
}

/**
 * Did the provider reject `reasoning_effort` outright?
 *
 * Exactly the `tool_choice` hazard one field over: a provider that has not
 * implemented the field 400s the WHOLE request instead of ignoring it, which
 * would turn "think harder" into "every send on this model fails". Matched on
 * the FIELD NAME, in both spellings that reach us — `reasoning_effort` on the
 * chat wire, `reasoning.effort` on OpenAI's Responses wire.
 */
export function isEffortRejection(error: unknown): boolean {
    return /reasoning[_.]effort/i.test(describeStreamError(error));
}

/** Workers AI publishes no level above 'high'. 'xhigh'/'max' exist on the
 *  spark and OpenAI wires only, so this is where the ladder is flattened —
 *  inventing a value a provider never documented is what made every
 *  gpt-5.6-luna request 400 in 2026-08. */
const WORKERS_AI_MAX_EFFORT = 'high';

/**
 * The resolved effort level in the shape the target provider actually reads.
 * Three wires, three shapes, each verified against the installed package:
 *
 *   `spark/`  → openai-compatible spreads `providerOptions[<name>]` into the
 *               request body and reads `reasoningEffort` as `reasoning_effort`.
 *   `@cf/`    → workers-ai-provider reads `providerOptions['workers-ai']
 *               .reasoning_effort` onto the run INPUTS (not the options arg).
 *   otherwise → every unified-billing id resolves through @ai-sdk/openai,
 *               whose `reasoningEffort` enum includes both of our levels.
 *
 * Returns undefined when there is no effort to send, which keeps
 * `providerOptions` off the request entirely rather than sending an empty one.
 */
export function effortProviderOptions(
    model: string, effort: EffortLevel | undefined,
): Record<string, Record<string, string>> | undefined {
    if (!effort) return undefined;
    if (model.startsWith(SPARK_PREFIX)) return { [SPARK_PROVIDER]: { reasoningEffort: effort } };
    if (model.startsWith('@cf/')) return { 'workers-ai': { reasoning_effort: WORKERS_AI_MAX_EFFORT } };
    return { openai: { reasoningEffort: effort } };
}

/** One-level merge of provider-options fragments. Fragments that name the
 *  SAME provider (prompt-cache key and reasoning effort both live under
 *  `openai`) merge their inner objects instead of one replacing the other —
 *  a plain spread would drop promptCacheKey silently, costing every
 *  prompt-cache discount on the Max tier's planner with no error to show for
 *  it. Undefined when nothing was contributed. */
function mergeProviderOptions(
    ...parts: Array<Record<string, Record<string, string>> | undefined>
): Record<string, Record<string, string>> | undefined {
    const merged: Record<string, Record<string, string>> = {};
    let contributed = false;
    for (const part of parts) {
        if (!part) continue;
        contributed = true;
        for (const [provider, options] of Object.entries(part)) {
            merged[provider] = { ...merged[provider], ...options };
        }
    }
    return contributed ? merged : undefined;
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

/**
 * Structured retry-after for a provider error, read off the AI SDK's
 * `APICallError.responseHeaders` (`Record<string, string> | undefined`, see
 * @ai-sdk/provider's index.d.ts). RFC 7231 allows either an integer seconds
 * count or an HTTP-date for `Retry-After`; header casing is not guaranteed to
 * survive whatever fetch/Headers normalization ran upstream, so the lookup is
 * case-insensitive. Clamped to [1, 3600] so a provider's second-off or
 * day-off value can never turn into a near-instant or near-infinite editor
 * retry. Undefined when the header is absent or neither shape parses — the
 * SSE error event then omits `retryAfterSeconds` entirely (see the `error`
 * case in streamCompletion below).
 */
export function retryAfterSecondsFrom(error: unknown): number | undefined {
    const headers = typeof error === 'object' && error !== null
        ? (error as { responseHeaders?: Record<string, string> }).responseHeaders
        : undefined;
    if (!headers) return undefined;
    const key = Object.keys(headers).find((k) => k.toLowerCase() === 'retry-after');
    const raw = key ? headers[key]?.trim() : undefined;
    if (!raw) return undefined;

    let seconds: number | undefined;
    if (/^\d+$/.test(raw)) {
        seconds = parseInt(raw, 10);
    } else {
        const deltaMs = Date.parse(raw) - Date.now();
        if (!Number.isNaN(deltaMs)) seconds = Math.ceil(deltaMs / 1000);
    }
    if (seconds === undefined || !Number.isFinite(seconds)) return undefined;
    return Math.min(3600, Math.max(1, seconds));
}

type StreamTextFn = typeof streamText;

export async function* streamCompletion(
    req: ChatCompletionRequest, env: LlmEnv, streamTextImpl: StreamTextFn = streamText,
    signal?: AbortSignal, catalog: Record<string, ModelInfo> = MODEL_CATALOG,
    // Reasoning effort is a PARAMETER, deliberately not a field on `req`:
    // config/routing.ts resolves it server-side from the already-gated tier,
    // and keeping it off the request body means an editor that sends its own
    // `effort` cannot reach the provider with it. Undefined sends none.
    effort?: EffortLevel,
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

    const forbidTools = req.tool_choice === 'none';
    const cacheOptions = cacheKey && req.model.startsWith('openai/')
        ? { openai: { promptCacheKey: cacheKey } }
        : undefined;
    const effortOptions = effortProviderOptions(req.model, effort);
    const baseArgs = {
        model, messages,
        // Client Stop/disconnect: without this the provider drained (and
        // billed) the full generation after the user stopped reading.
        ...(signal ? { abortSignal: signal } : {}),
        maxOutputTokens, temperature: req.temperature,
    };

    // At most three passes. The first sends what the caller asked for: with
    // `tool_choice: 'none'` the tools block stays in the prompt (heading the
    // provider's cached prefix) while tool calls are forbidden — the editor's
    // turn governor sends exactly that at the per-send call cap.
    //
    // Providers disagree about the field, and the ones that don't implement it
    // reject the ENTIRE request rather than ignoring it (see
    // isToolChoiceRejection) — so the turn died at precisely the moment the
    // agent was being told to wrap up. The second pass honours the same "no
    // tool calls" contract the only other way there is: by withholding
    // `tools`. That forfeits the cached prefix — the exact cost
    // `tool_choice: 'none'` exists to avoid — so it runs only after the
    // provider has actually refused the field, never speculatively.
    //
    // The same shape covers `reasoning_effort`, which is rejected the same way
    // by providers that don't implement it. The two fallbacks are independent
    // and compose: each rejection drops exactly the field it named and retries,
    // so a provider that implements neither still completes the turn on the
    // third pass. Hence three attempts, not two — and since every retry both
    // consumes an attempt and sets one drop flag, the last attempt is
    // guaranteed to be sending neither field, so the loop can never fall out
    // of its final pass still holding a rejection.
    let emitted = false;
    let dropToolChoice = false;
    let dropEffort = false;
    for (let attempt = 0; attempt < 3; attempt++) {
        const sendToolChoice = !dropToolChoice;
        const providerOptions = mergeProviderOptions(cacheOptions, dropEffort ? undefined : effortOptions);
        const result = streamTextImpl({
            ...baseArgs,
            ...(providerOptions ? { providerOptions } : {}),
            ...(sendToolChoice
                ? {
                    ...(tools ? { tools } : {}),
                    ...(forbidTools ? { toolChoice: 'none' as const } : {}),
                }
                : {}),
        });
        let rejected = false;

        for await (const part of result.fullStream) {
            // A provider that refuses one of these fields refuses it at request
            // validation, so this lands before the first token and `emitted` is
            // false. Check it anyway: retrying a half-delivered turn would replay
            // text the client has already rendered.
            if (part.type === 'error' && !emitted) {
                if (sendToolChoice && forbidTools && isToolChoiceRejection(part.error)) {
                    dropToolChoice = true;
                    rejected = true;
                    break;
                }
                if (!dropEffort && effortOptions && isEffortRejection(part.error)) {
                    dropEffort = true;
                    rejected = true;
                    break;
                }
            }
            switch (part.type) {
                case 'text-delta':
                    emitted = true;
                    yield { type: 'text', content: part.text };
                    break;
                case 'tool-call':
                    emitted = true;
                    yield {
                        type: 'tool_call', id: part.toolCallId, name: part.toolName,
                        arguments: JSON.stringify(part.input), finished: true,
                    };
                    break;
                case 'finish':
                    emitted = true;
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
                    emitted = true;
                    yield { type: 'thinking', thought: part.text, signature: '' };
                    break;
                case 'error': {
                    emitted = true;
                    const retryAfterSeconds = retryAfterSecondsFrom(part.error);
                    yield {
                        type: 'error', code: classifyStreamError(part.error), message: describeStreamError(part.error),
                        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
                    };
                    break;
                }
            }
        }
        if (!rejected) return;
    }
}
