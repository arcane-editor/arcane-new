import { streamText, jsonSchema } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { createOpenAI } from '@ai-sdk/openai';
import type { ModelMessage, ToolSet } from 'ai';
import type { ChatCompletionRequest, ChatMessage, StreamEvent, ToolDefinition } from '../types.ts';
import { getMaxOutput, wireFormatForNativeId } from '../lib/costs.ts';

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

export type LlmEnv = WorkersAiEnv;

export function resolveModel(
    modelId: string,
    env: LlmEnv,
    gatewayOverrides?: GatewayOverrides,
    modelSettings?: Record<string, unknown>,
) {
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
                        toolCallId: tc.id,
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

export type StreamErrorCode = 'rate_limit' | 'model_error';

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
    const maxOutputTokens = Math.min(req.max_tokens ?? 8192, getMaxOutput(req.model));

    const result = streamTextImpl({
        model, messages, ...(tools ? { tools } : {}),
        // 'none' keeps the tools block in the prompt (cached prefix) while
        // forbidding tool calls — the editor's turn governor sends it at the
        // per-send call cap.
        ...(req.tool_choice === 'none' ? { toolChoice: 'none' as const } : {}),
        ...(cacheKey && req.model.startsWith('openai/')
            ? { providerOptions: { openai: { promptCacheKey: cacheKey } } }
            : {}),
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
                yield { type: 'error', code: classifyStreamError(part.error), message: String(part.error) };
                break;
        }
    }
}
