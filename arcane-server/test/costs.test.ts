import { describe, it, expect } from 'vitest';
import { MODEL_CATALOG, estimateCost, getMaxOutput, getContextWindow } from '../src/lib/costs.ts';

describe('MODEL_CATALOG verified rates', () => {
    // Verbatim vendor rates. These are literal fixtures on purpose: an external
    // price table must fail loudly when someone "tidies" a number.
    it('gpt-5.6-luna', () => {
        const m = MODEL_CATALOG['openai/gpt-5.6-luna']!;
        expect(m.inputCostPer1M).toBe(0.20);
        expect(m.outputCostPer1M).toBe(1.20);
        expect(m.cachedInputCostPer1M).toBe(0.02);
        expect(m.contextWindow).toBe(1_050_000);
        expect(m.longContext!.thresholdTokens).toBe(272_000);
        expect(m.longContext!.inputCostPer1M).toBe(0.40);
        expect(m.longContext!.outputCostPer1M).toBe(1.80);
    });

    it('glm-5.2 has no long-context cliff', () => {
        const m = MODEL_CATALOG['@cf/zai-org/glm-5.2']!;
        expect(m.inputCostPer1M).toBe(1.40);
        expect(m.outputCostPer1M).toBe(4.40);
        expect(m.cachedInputCostPer1M).toBe(0.26);
        expect(m.contextWindow).toBe(262_144);
        expect(m.longContext).toBeUndefined();
    });

    it('grok-4.6', () => {
        const m = MODEL_CATALOG['xai/grok-4.6']!;
        expect(m.inputCostPer1M).toBe(2.00);
        expect(m.outputCostPer1M).toBe(6.00);
        expect(m.contextWindow).toBe(500_000);
        expect(m.longContext!.thresholdTokens).toBe(200_000);
        expect(m.longContext!.inputCostPer1M).toBe(4.00);
        expect(m.longContext!.outputCostPer1M).toBe(12.00);
        expect(m.longContext!.cachedInputCostPer1M).toBe(1.00);
    });

    it('glm-4.7-flash (inline)', () => {
        const m = MODEL_CATALOG['@cf/zai-org/glm-4.7-flash']!;
        expect(m.inputCostPer1M).toBe(0.06);
        expect(m.outputCostPer1M).toBe(0.40);
        expect(m.contextWindow).toBe(131_072);
    });

    it('gpt-5.6-sol (high-tier planner, unified/responses)', () => {
        const m = MODEL_CATALOG['openai/gpt-5.6-sol']!;
        expect(m.route).toBe('unified');
        expect(m.wireFormat).toBe('responses');
        expect(m.inputCostPer1M).toBe(5.00);
        expect(m.outputCostPer1M).toBe(30.00);
        expect(m.cachedInputCostPer1M).toBe(0.50);
        expect(m.contextWindow).toBe(400_000);
        expect(m.maxOutput).toBe(128_000);
    });

    it('spark/muse-spark-1.2-contributor (direct, no gateway)', () => {
        const m = MODEL_CATALOG['spark/muse-spark-1.2-contributor']!;
        expect(m.route).toBe('direct');
        expect(m.wireFormat).toBeUndefined();
        expect(m.inputCostPer1M).toBe(0.20);
        expect(m.outputCostPer1M).toBe(0.20);
        expect(m.cachedInputCostPer1M).toBe(0.20);
        expect(m.contextWindow).toBe(131_072);
        expect(m.maxOutput).toBe(16_384);
    });

    it('@cf/qwen/qwen3-30b-a3b-fp8 (new inline model)', () => {
        const m = MODEL_CATALOG['@cf/qwen/qwen3-30b-a3b-fp8']!;
        expect(m.route).toBe('workers-ai');
        expect(m.inputCostPer1M).toBe(0.051);
        expect(m.outputCostPer1M).toBe(0.34);
        expect(m.cachedInputCostPer1M).toBe(0.051);
        expect(m.contextWindow).toBe(32_768);
        expect(m.maxOutput).toBe(8_192);
    });
});

describe('estimateCost', () => {
    it('bills cached tokens at the cached rate', () => {
        // 10k fresh + 20k cached + 2k out on glm-5.2
        const cost = estimateCost('@cf/zai-org/glm-5.2', 30_000, 2_000, 20_000);
        // (10_000 * 1.40 + 20_000 * 0.26 + 2_000 * 4.40) / 1e6
        expect(cost).toBeCloseTo(0.028, 10);
    });

    it('treats inputTokens as inclusive of cachedTokens', () => {
        const all = estimateCost('@cf/zai-org/glm-5.2', 30_000, 0, 0);
        const some = estimateCost('@cf/zai-org/glm-5.2', 30_000, 0, 30_000);
        expect(all).toBeCloseTo(0.042, 10);
        expect(some).toBeCloseTo(0.0078, 10);
    });

    it('bills standard rates one token below the threshold', () => {
        const cost = estimateCost('xai/grok-4.6', 200_000, 1_000, 0);
        expect(cost).toBeCloseTo((200_000 * 2.00 + 1_000 * 6.00) / 1e6, 10);
    });

    it('rebills the ENTIRE request at long-context rates above the threshold', () => {
        const cost = estimateCost('xai/grok-4.6', 200_001, 1_000, 0);
        expect(cost).toBeCloseTo((200_001 * 4.00 + 1_000 * 12.00) / 1e6, 10);
    });

    it('applies long-context cached rate above the threshold', () => {
        const cost = estimateCost('xai/grok-4.6', 300_000, 1_000, 100_000);
        // 200k fresh @4.00 + 100k cached @1.00 + 1k out @12.00
        expect(cost).toBeCloseTo((200_000 * 4.00 + 100_000 * 1.00 + 1_000 * 12.00) / 1e6, 10);
    });

    it('returns 0 for an unknown model', () => {
        expect(estimateCost('nope/nope', 1000, 1000, 0)).toBe(0);
    });

    it('accepts an injectable catalog that overrides the default MODEL_CATALOG', () => {
        const overrideCatalog = {
            ...MODEL_CATALOG,
            '@cf/zai-org/glm-5.2': { ...MODEL_CATALOG['@cf/zai-org/glm-5.2']!, outputCostPer1M: 999.0 },
        };
        const overridden = estimateCost('@cf/zai-org/glm-5.2', 0, 1_000, 0, overrideCatalog);
        const stock = estimateCost('@cf/zai-org/glm-5.2', 0, 1_000, 0); // default arg -> MODEL_CATALOG
        expect(overridden).toBeCloseTo((1_000 * 999.0) / 1e6, 10);
        expect(stock).toBeCloseTo((1_000 * 4.40) / 1e6, 10);
        expect(overridden).not.toBe(stock);
    });

    it('a model absent from an injected catalog costs 0 even if it exists in MODEL_CATALOG', () => {
        expect(estimateCost('@cf/zai-org/glm-5.2', 1000, 1000, 0, {})).toBe(0);
    });
});

describe('lookups', () => {
    it('getContextWindow falls back to 32768', () => {
        expect(getContextWindow('xai/grok-4.6')).toBe(500_000);
        expect(getContextWindow('nope/nope')).toBe(32_768);
    });

    it('getMaxOutput falls back to 8192', () => {
        expect(getMaxOutput('nope/nope')).toBe(8192);
    });

    it('getContextWindow/getMaxOutput accept an injectable catalog', () => {
        const fixture = { 'custom/model': { ...MODEL_CATALOG['@cf/zai-org/glm-5.2']!, contextWindow: 1234, maxOutput: 55 } };
        expect(getContextWindow('custom/model', fixture)).toBe(1234);
        expect(getMaxOutput('custom/model', fixture)).toBe(55);
        // Absent from the injected catalog -> falls back to the DEFAULT, not MODEL_CATALOG's entry.
        expect(getContextWindow('xai/grok-4.6', fixture)).toBe(32_768);
    });
});

describe('route type', () => {
    it("'direct' is a valid route (spark provider) alongside 'workers-ai' and 'unified'", () => {
        expect(MODEL_CATALOG['spark/muse-spark-1.2-contributor']!.route).toBe('direct');
        expect(MODEL_CATALOG['@cf/zai-org/glm-5.2']!.route).toBe('workers-ai');
        expect(MODEL_CATALOG['xai/grok-4.6']!.route).toBe('unified');
    });
});
