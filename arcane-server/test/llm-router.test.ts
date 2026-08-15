import { describe, it, expect } from 'vitest';
import { resolveModel, classifyStreamError, convertMessages, describeStreamError, streamCompletion } from '../src/services/llm-router.ts';
import type { ChatCompletionRequest, ChatMessage, StreamEvent } from '../src/types.ts';

const ENV = { AI: {} as Ai, CF_AI_GATEWAY_ID: 'gw' };

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
});
