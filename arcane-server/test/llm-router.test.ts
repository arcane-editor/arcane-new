import { describe, it, expect } from 'vitest';
import { resolveModel, classifyStreamError, convertMessages, streamCompletion } from '../src/services/llm-router.ts';
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
            { type: 'usage', input_tokens: 10, output_tokens: 5, cached_input_tokens: 2 },
            { type: 'error', code: 'rate_limit', message: String(upstreamError) },
        ]);
    });
});
