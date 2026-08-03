import { describe, it, expect } from 'vitest';
import {
    isExternalModel, externalApiKey, gatewayCompatUrl, resolveModel, LlmConfigError,
    fallbackModelFor, shouldFallback, classifyStreamError, streamCompletion,
} from '../src/services/llm-router.ts';
import type { ChatCompletionRequest, StreamEvent } from '../src/types.ts';

const FULL_ENV = {
    AI: {} as Ai,
    CF_AI_GATEWAY_ID: 'gw-test',
    CF_ACCOUNT_ID: 'acct-test',
    MINIMAX_API_KEY: 'mk-test',
    MOONSHOT_API_KEY: 'msk-test',
};

describe('external model routing', () => {
    it('classifies @cf/ ids as internal, everything else as external', () => {
        expect(isExternalModel('@cf/zai-org/glm-5.2')).toBe(false);
        expect(isExternalModel('custom-minimax/MiniMax-M3')).toBe(true);
        expect(isExternalModel('custom-moonshot/kimi-k3')).toBe(true);
    });

    it('maps each custom-provider prefix to its secret', () => {
        expect(externalApiKey('custom-minimax/MiniMax-M3', FULL_ENV)).toBe('mk-test');
        expect(externalApiKey('custom-moonshot/kimi-k3', FULL_ENV)).toBe('msk-test');
    });

    it('throws LlmConfigError when the needed secret is missing', () => {
        expect(() => externalApiKey('custom-minimax/MiniMax-M3', {})).toThrow(LlmConfigError);
        expect(() => externalApiKey('custom-unknown/x', FULL_ENV)).toThrow(LlmConfigError);
    });

    it('builds the gateway /compat base URL and throws without CF_ACCOUNT_ID', () => {
        expect(gatewayCompatUrl(FULL_ENV)).toBe('https://gateway.ai.cloudflare.com/v1/acct-test/gw-test/compat');
        expect(() => gatewayCompatUrl({ CF_AI_GATEWAY_ID: 'gw-test' })).toThrow(LlmConfigError);
        expect(() => gatewayCompatUrl({ CF_ACCOUNT_ID: 'acct-test' })).toThrow(LlmConfigError);
    });

    it('resolveModel returns an AI SDK model carrying the requested id (both branches)', () => {
        expect(resolveModel('custom-minimax/MiniMax-M3', FULL_ENV).modelId).toBe('custom-minimax/MiniMax-M3');
        expect(resolveModel('@cf/zai-org/glm-5.2', FULL_ENV).modelId).toBe('@cf/zai-org/glm-5.2');
    });
});

describe('fallback policy', () => {
    it('maps external models to CF fallbacks, CF models to null', () => {
        expect(fallbackModelFor('custom-minimax/MiniMax-M3')).toBe('@cf/qwen/qwen2.5-coder-32b-instruct');
        expect(fallbackModelFor('custom-moonshot/kimi-k3')).toBe('@cf/zai-org/glm-5.2');
        expect(fallbackModelFor('@cf/zai-org/glm-5.2')).toBeNull();
    });

    it('falls back on 5xx/429/timeout/provider-auth, not on request errors', () => {
        expect(shouldFallback({ statusCode: 500 })).toBe(true);
        expect(shouldFallback({ statusCode: 429 })).toBe(true);
        expect(shouldFallback({ statusCode: 401 })).toBe(true);  // expired key → users keep working
        expect(shouldFallback(new Error('fetch failed'))).toBe(true);
        expect(shouldFallback({ statusCode: 400 })).toBe(false);
        expect(shouldFallback({ statusCode: 422 })).toBe(false);
    });

    it('classifies external errors with provider_* codes', () => {
        expect(classifyStreamError({ statusCode: 429 }, true)).toBe('provider_rate_limit');
        expect(classifyStreamError({ statusCode: 401 }, true)).toBe('provider_auth_failure');
        expect(classifyStreamError({ statusCode: 503 }, true)).toBe('provider_unavailable');
        expect(classifyStreamError(new Error('gateway timed out'), true)).toBe('gateway_timeout');
        expect(classifyStreamError({ statusCode: 429 }, false)).toBe('rate_limit');
        expect(classifyStreamError(new Error('capacity'), false)).toBe('rate_limit');
        expect(classifyStreamError(new Error('boom'), false)).toBe('model_error');
    });
});

describe('streamCompletion fallback', () => {
    const REQ: ChatCompletionRequest = {
        model: 'custom-minimax/MiniMax-M3',
        messages: [{ role: 'user', content: 'hi' }],
    };

    function fakeStreamText(partsByCall: Array<Array<Record<string, unknown>>>) {
        let call = 0;
        const fn = () => {
            const parts = partsByCall[Math.min(call, partsByCall.length - 1)];
            call += 1;
            return { fullStream: (async function* () { for (const p of parts) yield p; })() };
        };
        return fn as unknown as typeof import('ai').streamText;
    }

    it('emits a fallback event and the fallback model’s output when the primary errors pre-token', async () => {
        const impl = fakeStreamText([
            [{ type: 'error', error: { statusCode: 503 } }],
            [{ type: 'text-delta', text: 'hello' }],
        ]);
        const events: StreamEvent[] = [];
        for await (const e of streamCompletion(REQ, FULL_ENV, impl)) events.push(e);
        expect(events).toEqual([
            { type: 'fallback', model: '@cf/qwen/qwen2.5-coder-32b-instruct' },
            { type: 'text', content: 'hello' },
        ]);
    });

    it('does NOT fall back after content has streamed', async () => {
        const impl = fakeStreamText([
            [{ type: 'text-delta', text: 'partial' }, { type: 'error', error: { statusCode: 503 } }],
        ]);
        const events: StreamEvent[] = [];
        for await (const e of streamCompletion(REQ, FULL_ENV, impl)) events.push(e);
        expect(events[0]).toEqual({ type: 'text', content: 'partial' });
        expect(events[1]?.type).toBe('error');
    });

    it('falls back at most once (fallback errors surface as errors)', async () => {
        const impl = fakeStreamText([[{ type: 'error', error: { statusCode: 503 } }]]);
        const events: StreamEvent[] = [];
        for await (const e of streamCompletion(REQ, FULL_ENV, impl)) events.push(e);
        expect(events[0]?.type).toBe('fallback');
        expect(events[1]?.type).toBe('error');
    });

    it('falls back immediately on a config error (missing secret)', async () => {
        const impl = fakeStreamText([[{ type: 'text-delta', text: 'cf' }]]);
        const envNoKey = { ...FULL_ENV, MINIMAX_API_KEY: undefined };
        const events: StreamEvent[] = [];
        for await (const e of streamCompletion(REQ, envNoKey, impl)) events.push(e);
        expect(events[0]).toEqual({ type: 'fallback', model: '@cf/qwen/qwen2.5-coder-32b-instruct' });
        expect(events[1]).toEqual({ type: 'text', content: 'cf' });
    });
});
