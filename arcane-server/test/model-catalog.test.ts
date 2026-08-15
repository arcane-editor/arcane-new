import { describe, it, expect } from 'vitest';
import { INTENSITY_CONFIG, INLINE_MODEL, getIntensityConfig } from '../src/config/plans.ts';
import { MODEL_CATALOG, wireFormatForNativeId } from '../src/lib/costs.ts';

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

// Guard: Cloudflare's run catalog validates the request body against a
// PER-MODEL schema — the wrong wire format 400s on every request (the
// 2026-08-15 gpt-5.6-luna incident). Every unified-billing model must
// declare its verified format; adding one without deciding fails here.
describe('wire-format contract', () => {
    it('every unified-route model declares an explicit wireFormat', () => {
        for (const [slug, info] of Object.entries(MODEL_CATALOG)) {
            if (info.route === 'unified') {
                expect(info.wireFormat, `missing wireFormat: ${slug}`).toBeDefined();
            }
        }
    });

    it('matches the 2026-08-15 probe matrix (400-vs-402 verified live)', () => {
        expect(wireFormatForNativeId('gpt-5.6-luna')).toBe('responses'); // chat is schema-rejected
        expect(wireFormatForNativeId('grok-4.6')).toBe('chat');          // responses is schema-rejected
        expect(wireFormatForNativeId('gpt-5.4-mini')).toBe('chat');      // both accepted; we use chat
        expect(wireFormatForNativeId('glm-5.2')).toBeUndefined();        // workers-ai native, no gateway schema
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
