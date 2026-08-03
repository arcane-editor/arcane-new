import { describe, it, expect } from 'vitest';
import { INTENSITY_CONFIG, INLINE_MODEL } from '../src/config/plans.ts';
import { MODEL_CATALOG } from '../src/lib/costs.ts';

describe('model catalog coverage', () => {
    it('every routed model (intensity tiers + inline) has a MODEL_CATALOG entry', () => {
        const routed = new Set<string>([
            ...Object.values(INTENSITY_CONFIG).map((c) => c.model),
            INLINE_MODEL,
        ]);
        for (const model of routed) {
            expect(
                MODEL_CATALOG[model],
                `MODEL_CATALOG is missing "${model}" — estimateCost() would return $0 and silently skip the credit debit`,
            ).toBeDefined();
        }
    });

    it('tier map matches the approved spec', () => {
        expect(INTENSITY_CONFIG.low.model).toBe('custom-minimax/MiniMax-M3');
        expect(INTENSITY_CONFIG.mid.model).toBe('@cf/zai-org/glm-5.2');
        expect(INTENSITY_CONFIG.high.model).toBe('custom-moonshot/kimi-k3');
        expect(INTENSITY_CONFIG.super.model).toBe('custom-moonshot/kimi-k3');
        expect(INLINE_MODEL).toBe('@cf/qwen/qwen2.5-coder-32b-instruct');
    });
});
