import { describe, it, expect } from 'vitest';
import {
    isExternalModel, externalApiKey, gatewayCompatUrl, resolveModel, LlmConfigError,
} from '../src/services/llm-router.ts';

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
