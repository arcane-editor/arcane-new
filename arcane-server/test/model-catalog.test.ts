import { describe, it, expect } from 'vitest';
import { INTENSITY_CONFIG, getIntensityConfig, DEFAULT_MODEL_ROUTING, EXECUTOR_MODEL, SPARK_MODEL } from '../src/config/plans.ts';
import { MODEL_CATALOG, wireFormatForNativeId } from '../src/lib/costs.ts';

describe('INTENSITY_CONFIG', () => {
    it('is label/description-only — model choice moved to the runtime routing doc', () => {
        for (const cfg of Object.values(INTENSITY_CONFIG)) {
            expect(cfg).not.toHaveProperty('model');
            expect(typeof cfg.label).toBe('string');
            expect(typeof cfg.description).toBe('string');
        }
    });

    it('carries user-facing labels', () => {
        expect(INTENSITY_CONFIG.low.label).toBe('Standard');
        expect(INTENSITY_CONFIG.mid.label).toBe('Deep Think');
        expect(INTENSITY_CONFIG.high.label).toBe('Max');
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
        expect(wireFormatForNativeId('gpt-5.6-sol')).toBe('responses');  // same family as luna
        expect(wireFormatForNativeId('grok-4.6')).toBe('chat');          // responses is schema-rejected
        expect(wireFormatForNativeId('gpt-5.4-mini')).toBe('chat');      // both accepted; we use chat
        expect(wireFormatForNativeId('glm-5.2')).toBeUndefined();        // workers-ai native, no gateway schema
    });
});

// Guard A1: a tier pointing at a model with no catalog entry silently bills $0.
describe('catalog guard', () => {
    it('every model referenced by DEFAULT_MODEL_ROUTING has a MODEL_CATALOG entry', () => {
        for (const [tierName, tier] of Object.entries(DEFAULT_MODEL_ROUTING.tiers)) {
            expect(MODEL_CATALOG[tier.planner], `missing catalog entry: ${tierName}.planner (${tier.planner})`).toBeDefined();
            expect(MODEL_CATALOG[tier.executor], `missing catalog entry: ${tierName}.executor (${tier.executor})`).toBeDefined();
            if (tier.executorHard) {
                expect(MODEL_CATALOG[tier.executorHard], `missing catalog entry: ${tierName}.executorHard (${tier.executorHard})`).toBeDefined();
            }
        }
        expect(MODEL_CATALOG[DEFAULT_MODEL_ROUTING.inline], `missing catalog entry: inline (${DEFAULT_MODEL_ROUTING.inline})`).toBeDefined();
    });
});

// Role pins — catches an accidental swap of which model serves which
// planner/executor/executorHard slot in the code-default routing doc.
describe('DEFAULT_MODEL_ROUTING role pins', () => {
    it('low: glm-5.3-flash planner, glm-5.3-flash executor', () => {
        expect(DEFAULT_MODEL_ROUTING.tiers.low.planner).toBe(EXECUTOR_MODEL);
        expect(DEFAULT_MODEL_ROUTING.tiers.low.executor).toBe(EXECUTOR_MODEL);
        expect(DEFAULT_MODEL_ROUTING.tiers.low.executorHard).toBeUndefined();
    });

    it('mid: grok planner, glm-5.3-flash executor', () => {
        expect(DEFAULT_MODEL_ROUTING.tiers.mid.planner).toBe('xai/grok-4.6');
        expect(DEFAULT_MODEL_ROUTING.tiers.mid.executor).toBe(EXECUTOR_MODEL);
        expect(DEFAULT_MODEL_ROUTING.tiers.mid.executorHard).toBeUndefined();
    });

    it('high: sol planner, glm-5.3-flash executor, grok executorHard', () => {
        expect(DEFAULT_MODEL_ROUTING.tiers.high.planner).toBe('openai/gpt-5.6-sol');
        expect(DEFAULT_MODEL_ROUTING.tiers.high.executor).toBe(EXECUTOR_MODEL);
        expect(DEFAULT_MODEL_ROUTING.tiers.high.executorHard).toBe('xai/grok-4.6');
    });

    // Spark served every executor slot until 2026-08-27. Its catalog entry has
    // to survive the swap — usage rows are keyed by model id, so deleting it
    // would silently zero the cost of every historical debit against it.
    it('keeps the retired spark entry in the catalog, unrouted', () => {
        expect(MODEL_CATALOG[SPARK_MODEL]).toBeDefined();
        const routed = Object.values(DEFAULT_MODEL_ROUTING.tiers).flatMap((t) =>
            [t.planner, t.executor, t.executorHard].filter(Boolean),
        );
        expect(routed).not.toContain(SPARK_MODEL);
    });

    it('inline: qwen3-30b', () => {
        expect(DEFAULT_MODEL_ROUTING.inline).toBe('@cf/qwen/qwen3-30b-a3b-fp8');
    });
});
