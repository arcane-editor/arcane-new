import { describe, it, expect } from 'vitest';
import { estimateCost, getMaxOutput, MODEL_CATALOG } from '../src/lib/costs.ts';

describe('estimateCost', () => {
    it('prices the embedding model (bge-small) input tokens — not $0', () => {
        // Regression: bge-small was absent from MODEL_CATALOG, so every
        // embeddings / unity-search request metered at $0 cost.
        const cost = estimateCost('@cf/baai/bge-small-en-v1.5', 1_000_000, 0);
        expect(cost).toBeCloseTo(0.02, 6);
        expect(cost).toBeGreaterThan(0);
    });

    it('embeddings have no output-token cost', () => {
        const inputOnly = estimateCost('@cf/baai/bge-small-en-v1.5', 500_000, 0);
        const withOutput = estimateCost('@cf/baai/bge-small-en-v1.5', 500_000, 999_999);
        expect(withOutput).toBe(inputOnly);
    });

    it('prices chat models by blended input+output rate', () => {
        // kimi (mid): 0.60/1M in + 2.40/1M out
        const cost = estimateCost('@cf/moonshotai/kimi-k2.7-code', 1_000_000, 1_000_000);
        expect(cost).toBeCloseTo(3.0, 6);
    });

    it('returns 0 for an unknown model id', () => {
        expect(estimateCost('@cf/unknown/model', 1_000_000, 1_000_000)).toBe(0);
    });
});

describe('getMaxOutput', () => {
    it('is 0 for the embedding model (never generates)', () => {
        expect(getMaxOutput('@cf/baai/bge-small-en-v1.5')).toBe(0);
    });

    it('every chat model resolves a positive clamp', () => {
        for (const [id, info] of Object.entries(MODEL_CATALOG)) {
            if (info.outputCostPer1M > 0) expect(getMaxOutput(id), id).toBeGreaterThan(0);
        }
    });
});
