import { describe, it, expect } from 'vitest';
import { INTENSITY_CONFIG, INLINE_MODEL, getIntensityConfig } from '../src/config/plans.ts';
import { MODEL_CATALOG } from '../src/lib/costs.ts';

describe('INTENSITY_CONFIG', () => {
    it('maps each tier to its model', () => {
        expect(INTENSITY_CONFIG.low.model).toBe('openai/gpt-5.6-luna');
        expect(INTENSITY_CONFIG.mid.model).toBe('@cf/zai-org/glm-5.2');
        expect(INTENSITY_CONFIG.high.model).toBe('xai/grok-4.6');
    });

    it('carries user-facing labels', () => {
        expect(INTENSITY_CONFIG.low.label).toBe('Standard');
        expect(INTENSITY_CONFIG.mid.label).toBe('Deep Think');
        expect(INTENSITY_CONFIG.high.label).toBe('Max');
    });

    it('uses glm-4.7-flash for inline', () => {
        expect(INLINE_MODEL).toBe('@cf/zai-org/glm-4.7-flash');
    });
});

describe('getIntensityConfig', () => {
    it('accepts the legacy super value and returns high', () => {
        expect(getIntensityConfig('super')).toBe(INTENSITY_CONFIG.high);
    });

    it('returns undefined for an unknown level', () => {
        expect(getIntensityConfig('turbo')).toBeUndefined();
    });
});

// Guard A1: a tier pointing at a model with no catalog entry silently bills $0.
describe('catalog guard', () => {
    it('every routed model exists in MODEL_CATALOG', () => {
        for (const cfg of Object.values(INTENSITY_CONFIG)) {
            expect(MODEL_CATALOG[cfg.model], `missing catalog entry: ${cfg.model}`).toBeDefined();
        }
        expect(MODEL_CATALOG[INLINE_MODEL]).toBeDefined();
    });
});
