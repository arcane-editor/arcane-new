import { streamText, jsonSchema } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import type { ModelMessage, ToolSet } from 'ai';
import type { ChatCompletionRequest, ChatMessage, StreamEvent, ToolDefinition } from '../types.ts';
import { getMaxOutput } from '../lib/costs.ts';

// Everything routes through Cloudflare Workers AI via the AI Gateway.
// The Worker only needs the `AI` binding + a gateway id — no provider API keys.
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

export function resolveModel(modelId: string, env: WorkersAiEnv, gatewayOverrides?: GatewayOverrides) {
    // modelId is a Workers AI catalog id (e.g. '@cf/zai-org/glm-5.2' or 'minimax/m3'),
    // resolved entirely on the backend from the request's reasoningLevel.
    return workersAiProvider(env, gatewayOverrides)(modelId as string);
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

export async function* streamCompletion(req: ChatCompletionRequest, env: WorkersAiEnv): AsyncGenerator<StreamEvent> {
    // A cached replay of a sampled completion is semantically wrong — chat
    // completions are non-deterministic (temperature-sampled), so bypass the
    // gateway cache for this path.
    const model = resolveModel(req.model, env, { skipCache: true });
    const messages = convertMessages(req.messages);
    const tools = convertTools(req.tools);

    // Clamp output tokens to the model's published cap (Workers AI models vary).
    const cap = getMaxOutput(req.model);
    const requested = req.max_tokens ?? 8192;
    const maxOutputTokens = Math.min(requested, cap);

    const result = streamText({
        model,
        messages,
        ...(tools ? { tools } : {}),
        maxOutputTokens,
        temperature: req.temperature,
    });

    for await (const part of result.fullStream) {
        switch (part.type) {
            case 'text-delta':
                yield { type: 'text', content: part.text };
                break;
            case 'tool-call':
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
                yield { type: 'thinking', thought: part.text, signature: '' };
                break;
            case 'error': {
                const message = String(part.error);
                // Workers AI error code 3021 is the platform's rate-limit code;
                // also match the common textual markers case-insensitively.
                const isRateLimit = /rate limit|429|3021/i.test(message);
                yield { type: 'error', code: isRateLimit ? 'rate_limit' : 'model_error', message };
                break;
            }
        }
    }
}
