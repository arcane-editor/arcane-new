import { describe, it, expect } from 'vitest';
import {
    resolveModel, classifyStreamError, convertMessages, describeStreamError, streamCompletion,
    LlmConfigError, type LlmEnv,
} from '../src/services/llm-router.ts';
import { SPARK_MODEL } from '../src/config/plans.ts';
import type { ChatCompletionRequest, ChatMessage, StreamEvent } from '../src/types.ts';
import type { ModelInfo } from '../src/lib/costs.ts';

const ENV = { AI: {} as Ai, CF_AI_GATEWAY_ID: 'gw' };
const SPARK_ENV: LlmEnv = { AI: {} as Ai, SPARK_BASE_URL: 'https://spark.invalid', SPARK_API_KEY: 'test-spark-key' };

describe('resolveModel', () => {
    it('resolves Workers AI ids through the binding', () => {
        expect(resolveModel('@cf/zai-org/glm-5.2', ENV).modelId).toBe('@cf/zai-org/glm-5.2');
    });

    it('resolves unified-billing ids through the same binding', () => {
        // workers-ai-provider's gateway delegate strips the resolver-key
        // segment ("openai"/"xai") before handing the id to the underlying
        // @ai-sdk provider — that stripped id is what's sent in the actual
        // upstream request body, so `.modelId` reflects the provider-native
        // id, not the full gateway slug. Verified against workers-ai-provider
        // 3.2.0 (see gateway-delegate.ts `parseSlug`).
        expect(resolveModel('openai/gpt-5.6-luna', ENV).modelId).toBe('gpt-5.6-luna');
        expect(resolveModel('xai/grok-4.6', ENV).modelId).toBe('grok-4.6');
    });
});

// Spark: the first (and so far only) 'direct' route in MODEL_CATALOG — an
// OpenAI-compatible provider called with the owner's own key, no CF AI
// Gateway/binding involved. No real Spark credentials exist yet; these cover
// resolveModel's config-error and success paths only, never a live call.
describe('resolveModel: spark direct provider', () => {
    it('throws LlmConfigError naming SPARK_BASE_URL when it is unset', () => {
        expect(() => resolveModel(SPARK_MODEL, { AI: {} as Ai })).toThrow(LlmConfigError);
        expect(() => resolveModel(SPARK_MODEL, { AI: {} as Ai })).toThrow(/SPARK_BASE_URL/);
    });

    it('throws LlmConfigError naming SPARK_API_KEY when the base URL is set but the key is not', () => {
        const env: LlmEnv = { AI: {} as Ai, SPARK_BASE_URL: 'https://spark.invalid' };
        expect(() => resolveModel(SPARK_MODEL, env)).toThrow(LlmConfigError);
        expect(() => resolveModel(SPARK_MODEL, env)).toThrow(/SPARK_API_KEY/);
    });

    it('resolves to the spark provider with the prefix stripped, given both bindings', () => {
        const model = resolveModel(SPARK_MODEL, SPARK_ENV);
        expect(model.modelId).toBe('muse-spark-1.2-contributor');
        // @ai-sdk/openai-compatible's `.provider` getter returns
        // `${name}.${modelType}` (e.g. 'spark.chat') — verified against the
        // installed 2.0.30 source (openai-compatible-provider.ts
        // getCommonModelConfig). The `name` half is what we configured.
        expect(model.provider.split('.')[0]).toBe('spark');
    });
});

describe('classifyStreamError', () => {
    it('maps a 429 status to rate_limit', () => {
        expect(classifyStreamError({ statusCode: 429 })).toBe('rate_limit');
    });

    it('maps Workers AI internal capacity codes to rate_limit', () => {
        expect(classifyStreamError(new Error('error 3036: capacity'))).toBe('rate_limit');
    });

    it('falls back to model_error', () => {
        expect(classifyStreamError(new Error('boom'))).toBe('model_error');
    });
});

// `content: null` is the OpenAI convention for an assistant turn that carried
// no text, and the editor emits exactly that (openai-format.ts: `textParts ||
// null`) whenever a turn produced only thinking, only tool calls, or was cut
// short. `typeof null === 'object'`, so the array branch used to run and call
// `null.filter(...)` — one such message anywhere in the history 500'd every
// subsequent send in that conversation.
describe('convertMessages tolerates null content', () => {
    it('handles an assistant turn with no text and no tool calls', () => {
        const messages = [{ role: 'assistant', content: null }] as unknown as ChatMessage[];
        expect(() => convertMessages(messages)).not.toThrow();
        expect(convertMessages(messages)).toEqual([{ role: 'assistant', content: '' }]);
    });

    it('handles an assistant turn with null content alongside tool calls', () => {
        const messages = [{
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"p":1}' } }],
        }] as unknown as ChatMessage[];
        expect(() => convertMessages(messages)).not.toThrow();
        expect(convertMessages(messages)[0].content).toEqual([
            { type: 'tool-call', toolCallId: 'c1', toolName: 'read', input: { p: 1 } },
        ]);
    });

    it('handles null content on system and tool messages too', () => {
        expect(() => convertMessages([{ role: 'system', content: null }] as unknown as ChatMessage[])).not.toThrow();
        expect(() => convertMessages(
            [{ role: 'tool', content: null, tool_call_id: 'c1', name: 'read' }] as unknown as ChatMessage[],
        )).not.toThrow();
    });
});

// Cross-model tool-call id replay (incident 2026-08-15 #2): workers-ai-provider
// tags @cf tool-call ids with `::cf-wai-tool-call::<nonce>` and strips the tag
// itself only when replaying to a @cf model. The openai wire path forwards ids
// verbatim, and OpenAI validates them against ^[a-zA-Z0-9_-]+$ — so one glm
// planning turn in history 400'd every later luna send of the conversation
// ("AI_APICallError: Bad Request"). convertMessages therefore normalizes ids
// for every model, keeping call/result pairs consistent.
describe('convertMessages sanitizes tool-call ids', () => {
    const MARKED = 'call_03847512860a4206bdc02a51::cf-wai-tool-call::hYq6TKFpEHXfw4Ol';

    it('strips the workers-ai round-trip marker from calls and results alike', () => {
        const out = convertMessages([
            {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: MARKED, type: 'function', function: { name: 'read', arguments: '{}' } }],
            },
            { role: 'tool', content: 'ok', tool_call_id: MARKED, name: 'read' },
        ] as unknown as ChatMessage[]);
        const call = (out[0].content as Array<{ type: string; toolCallId?: string }>).find(p => p.type === 'tool-call')!;
        const result = (out[1].content as Array<{ type: string; toolCallId?: string }>)[0];
        expect(call.toolCallId).toBe('call_03847512860a4206bdc02a51');
        expect(result.toolCallId).toBe('call_03847512860a4206bdc02a51');
    });

    it('normalizes any residual character outside [A-Za-z0-9_-]', () => {
        const out = convertMessages([
            { role: 'tool', content: 'ok', tool_call_id: 'id with:odd/chars', name: 'read' },
        ] as unknown as ChatMessage[]);
        expect((out[0].content as Array<{ toolCallId: string }>)[0].toolCallId).toBe('id_with_odd_chars');
    });

    it('keeps already-valid provider ids byte-identical (cache stability)', () => {
        const out = convertMessages([
            { role: 'tool', content: 'ok', tool_call_id: 'call_abc-DEF_123', name: 'read' },
        ] as unknown as ChatMessage[]);
        expect((out[0].content as Array<{ toolCallId: string }>)[0].toolCallId).toBe('call_abc-DEF_123');
    });

    it('never produces an empty id, even for a bare marker id', () => {
        const bare = '::cf-wai-tool-call::hYq6TKFpEHXfw4Ol';
        const out = convertMessages([
            { role: 'tool', content: 'ok', tool_call_id: bare, name: 'read' },
        ] as unknown as ChatMessage[]);
        const id = (out[0].content as Array<{ toolCallId: string }>)[0].toolCallId;
        expect(id.length).toBeGreaterThan(0);
        expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
    });
});

describe('describeStreamError', () => {
    it('appends status code and upstream body when the error carries them', () => {
        const err = Object.assign(new Error('Bad Request'), {
            statusCode: 400,
            responseBody: '{"error":{"message":"Invalid \'input[2].call_id\'"}}',
        });
        const msg = describeStreamError(err);
        expect(msg).toContain('[status 400]');
        expect(msg).toContain("Invalid 'input[2].call_id'");
    });

    it('leaves plain errors unchanged', () => {
        expect(describeStreamError(new Error('boom'))).toBe('Error: boom');
    });
});

// `streamCompletion` folded `streamOnce` back into itself once the fallback
// machinery was deleted (Task 5); this is the one behavioral test for the
// resulting generator, using the `streamTextImpl` injection seam to feed a
// scripted `fullStream` covering every part type it switches on.
describe('streamCompletion event mapping', () => {
    const REQ: ChatCompletionRequest = {
        model: '@cf/zai-org/glm-5.2',
        messages: [{ role: 'user', content: 'hi' }],
    };

    function fakeStreamText(parts: Array<Record<string, unknown>>) {
        const fn = () => ({ fullStream: (async function* () { for (const p of parts) yield p; })() });
        return fn as unknown as typeof import('ai').streamText;
    }

    it('maps each fullStream part type to its StreamEvent shape', async () => {
        const upstreamError = Object.assign(new Error('rate limited'), { statusCode: 429 });
        const impl = fakeStreamText([
            { type: 'text-delta', text: 'hello' },
            { type: 'tool-call', toolCallId: 'c1', toolName: 'read_file', input: { path: 'a.ts' } },
            { type: 'reasoning-delta', text: 'thinking it through' },
            {
                type: 'finish',
                // `cached_input_tokens` feeds request_logs.cached_input_tokens, which
                // feeds billing — this is the assertion that matters most here.
                totalUsage: { inputTokens: 10, outputTokens: 5, inputTokenDetails: { cacheReadTokens: 2 } },
            },
            { type: 'error', error: upstreamError },
        ]);

        const events: StreamEvent[] = [];
        for await (const e of streamCompletion(REQ, ENV, impl)) events.push(e);

        expect(events).toEqual([
            { type: 'text', content: 'hello' },
            { type: 'tool_call', id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'a.ts' }), finished: true },
            { type: 'thinking', thought: 'thinking it through', signature: '' },
            { type: 'usage', model: '@cf/zai-org/glm-5.2', input_tokens: 10, output_tokens: 5, cached_input_tokens: 2 },
            { type: 'error', code: 'rate_limit', message: `${String(upstreamError)} [status 429]` },
        ]);
    });

    it("passes tool_choice 'none' through to streamText (governor at cap keeps tools cached)", async () => {
        const seen: Array<Record<string, unknown>> = [];
        const impl = ((args: Record<string, unknown>) => {
            seen.push(args);
            return { fullStream: (async function* () {})() };
        }) as unknown as typeof import('ai').streamText;

        for await (const _ of streamCompletion({ ...REQ, tool_choice: 'none' }, ENV, impl)) { /* drain */ }
        for await (const _ of streamCompletion(REQ, ENV, impl)) { /* drain */ }

        expect(seen[0].toolChoice).toBe('none');
        expect('toolChoice' in seen[1]).toBe(false);
    });

    it('forwards the abort signal to streamText so a client Stop cancels the provider call', async () => {
        const seen: Array<Record<string, unknown>> = [];
        const impl = ((args: Record<string, unknown>) => {
            seen.push(args);
            return { fullStream: (async function* () {})() };
        }) as unknown as typeof import('ai').streamText;

        const ctl = new AbortController();
        for await (const _ of streamCompletion(REQ, ENV, impl, ctl.signal)) { /* drain */ }
        for await (const _ of streamCompletion(REQ, ENV, impl)) { /* drain */ }

        expect(seen[0].abortSignal).toBe(ctl.signal);
        expect('abortSignal' in seen[1]).toBe(false);
    });

    it('sends prompt_cache_key (via providerOptions.openai) only for openai/* models with a session id', async () => {
        const seen: Array<Record<string, unknown>> = [];
        const impl = ((args: Record<string, unknown>) => {
            seen.push(args);
            return { fullStream: (async function* () {})() };
        }) as unknown as typeof import('ai').streamText;

        const withSession = (model: string): ChatCompletionRequest => ({
            model, messages: [{ role: 'user', content: 'hi' }],
            metadata: { sessionId: 'conv_123' },
        });

        for await (const _ of streamCompletion(withSession('openai/gpt-5.6-luna'), ENV, impl)) { /* drain */ }
        for await (const _ of streamCompletion(withSession('@cf/zai-org/glm-5.2'), ENV, impl)) { /* drain */ }
        for await (const _ of streamCompletion({ model: 'openai/gpt-5.6-luna', messages: [{ role: 'user', content: 'hi' }] }, ENV, impl)) { /* drain */ }

        expect(seen[0].providerOptions).toEqual({ openai: { promptCacheKey: 'conv_123' } });
        expect('providerOptions' in seen[1]).toBe(false);
        expect('providerOptions' in seen[2]).toBe(false);
    });

    it('passes sessionAffinity into @cf model settings (x-session-affinity routing hint)', () => {
        const model = resolveModel('@cf/zai-org/glm-5.2', ENV, undefined, { sessionAffinity: 'conv_123' });
        expect((model as unknown as { settings: { sessionAffinity?: string } }).settings.sessionAffinity).toBe('conv_123');
    });

    // Mixed spark↔grok history (incident-2026-08-15-#2 shape, new route): a
    // @cf-marked tool-call id minted on an earlier turn gets replayed once for
    // a spark completion and once for a grok one. Same convertMessages
    // pipeline serves both routes, so the sanitized id (and the call/result
    // pairing) must come out identical regardless of which model is about to
    // run — this exercises the full streamCompletion pipeline (resolveModel +
    // convertMessages together), not just convertMessages in isolation.
    it('sanitizes a @cf-marked tool-call id identically whether the next turn is spark or grok', async () => {
        const seen: Array<Record<string, unknown>> = [];
        const impl = ((args: Record<string, unknown>) => {
            seen.push(args);
            return { fullStream: (async function* () {})() };
        }) as unknown as typeof import('ai').streamText;

        const marked = 'call_5f2a9c::cf-wai-tool-call::nonceXYZ';
        const history: ChatMessage[] = [
            { role: 'user', content: 'read config.json' },
            {
                role: 'assistant', content: null,
                tool_calls: [{ id: marked, type: 'function', function: { name: 'read_file', arguments: '{"path":"config.json"}' } }],
            },
            { role: 'tool', content: '{}', tool_call_id: marked, name: 'read_file' },
        ];

        for await (const _ of streamCompletion({ model: SPARK_MODEL, messages: history }, SPARK_ENV, impl)) { /* drain */ }
        for await (const _ of streamCompletion({ model: 'xai/grok-4.6', messages: history }, ENV, impl)) { /* drain */ }

        expect(seen).toHaveLength(2);
        for (const call of seen) {
            const messages = call.messages as Array<{ content: unknown }>;
            const toolCall = (messages[1].content as Array<{ type: string; toolCallId?: string }>).find(p => p.type === 'tool-call')!;
            const toolResult = (messages[2].content as Array<{ type: string; toolCallId?: string }>)[0];
            expect(toolCall.toolCallId).toBe('call_5f2a9c');
            expect(toolResult.toolCallId).toBe('call_5f2a9c');
        }
    });
});

// `catalog` (streamCompletion's trailing param, wired from chat.ts's
// getEffectivePricing) drives the maxOutputTokens clamp via getMaxOutput —
// callers on the effective-pricing path must see an admin override honored,
// and every other caller (tests, or a future call site with no catalog) must
// still see the code-default MODEL_CATALOG.
describe('streamCompletion maxOutputTokens clamp uses the passed catalog', () => {
    function fakeStreamText() {
        const seen: Array<Record<string, unknown>> = [];
        const fn = ((args: Record<string, unknown>) => {
            seen.push(args);
            return { fullStream: (async function* () {})() };
        }) as unknown as typeof import('ai').streamText;
        return { seen, fn };
    }

    it('clamps to the passed catalog entry for a spark id (16_384 per the seed entry)', async () => {
        const { seen, fn } = fakeStreamText();
        const catalog: Record<string, ModelInfo> = {
            [SPARK_MODEL]: {
                route: 'direct',
                inputCostPer1M: 0.2, outputCostPer1M: 0.2, cachedInputCostPer1M: 0.2,
                contextWindow: 131_072, maxOutput: 16_384,
            },
        };
        const req: ChatCompletionRequest = {
            model: SPARK_MODEL,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 999_999, // far above the catalog cap — the clamp must win
        };

        for await (const _ of streamCompletion(req, SPARK_ENV, fn, undefined, catalog)) { /* drain */ }

        expect(seen[0].maxOutputTokens).toBe(16_384);
    });

    it('falls back to the code-default MODEL_CATALOG when no catalog is passed', async () => {
        const { seen, fn } = fakeStreamText();
        const req: ChatCompletionRequest = {
            model: SPARK_MODEL,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 999_999,
        };

        for await (const _ of streamCompletion(req, SPARK_ENV, fn)) { /* drain */ }

        expect(seen[0].maxOutputTokens).toBe(16_384); // MODEL_CATALOG's real seed entry
    });
});
