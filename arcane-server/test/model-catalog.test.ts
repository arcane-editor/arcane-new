import { describe, it, expect } from 'vitest';
import {
    INTENSITY_CONFIG, getIntensityConfig, DEFAULT_MODEL_ROUTING,
    SPARK_MODEL, LEGACY_SPARK_MODEL, FLASH_MODEL, PLANNER_MODEL,
} from '../src/config/plans.ts';
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
    it('low: spark planner, spark executor', () => {
        expect(DEFAULT_MODEL_ROUTING.tiers.low.planner).toBe(SPARK_MODEL);
        expect(DEFAULT_MODEL_ROUTING.tiers.low.executor).toBe(SPARK_MODEL);
        expect(DEFAULT_MODEL_ROUTING.tiers.low.executorHard).toBeUndefined();
    });

    it('mid: glm-5.3 planner, spark executor', () => {
        expect(DEFAULT_MODEL_ROUTING.tiers.mid.planner).toBe(PLANNER_MODEL);
        expect(DEFAULT_MODEL_ROUTING.tiers.mid.executor).toBe(SPARK_MODEL);
        expect(DEFAULT_MODEL_ROUTING.tiers.mid.executorHard).toBeUndefined();
    });

    it('high: sol planner, spark executor, glm-5.3 executorHard', () => {
        expect(DEFAULT_MODEL_ROUTING.tiers.high.planner).toBe('openai/gpt-5.6-sol');
        expect(DEFAULT_MODEL_ROUTING.tiers.high.executor).toBe(SPARK_MODEL);
        expect(DEFAULT_MODEL_ROUTING.tiers.high.executorHard).toBe(PLANNER_MODEL);
    });

    /** Every model id the code-default doc routes to, in slot order. */
    function routedModels(): string[] {
        return Object.values(DEFAULT_MODEL_ROUTING.tiers).flatMap((t) =>
            [t.planner, t.executor, t.executorHard].filter((m): m is string => Boolean(m)),
        );
    }

    // Retirement contract, applied three times over now: a model that stops
    // being routed KEEPS its catalog entry, because usage rows are keyed by
    // model id — deleting one silently zeroes the cost of every historical
    // debit against it (and forfeits the one-line rollback).
    it('keeps spark 1.2 in the catalog, unrouted — superseded by 1.3', () => {
        expect(MODEL_CATALOG[LEGACY_SPARK_MODEL]).toBeDefined();
        expect(routedModels()).not.toContain(LEGACY_SPARK_MODEL);
    });

    // glm-5.3-flash held every slot spark 1.3 now holds, between 2026-08-27
    // and 2026-09-03. It is the documented rollback.
    it('keeps glm-5.3-flash in the catalog, unrouted', () => {
        expect(MODEL_CATALOG[FLASH_MODEL]).toBeDefined();
        expect(routedModels()).not.toContain(FLASH_MODEL);
    });

    it('keeps the retired grok entry in the catalog, unrouted', () => {
        expect(MODEL_CATALOG['xai/grok-4.6']).toBeDefined();
        expect(routedModels()).not.toContain('xai/grok-4.6');
    });

    // Spark is a 'direct'-route model — no Cloudflare in the path at all — so
    // routing it puts a slot on an entirely different failure domain from the
    // rest of the lineup. Worth stating explicitly rather than inferring.
    it('spark 1.3 is a direct-route catalog entry with the 1.2 seed carried over', () => {
        const spark = MODEL_CATALOG[SPARK_MODEL]!;
        const legacy = MODEL_CATALOG[LEGACY_SPARK_MODEL]!;
        expect(spark.route).toBe('direct');
        expect(spark.inputCostPer1M).toBe(legacy.inputCostPer1M);
        expect(spark.outputCostPer1M).toBe(legacy.outputCostPer1M);
        expect(spark.cachedInputCostPer1M).toBe(legacy.cachedInputCostPer1M);
        expect(spark.contextWindow).toBe(131_072);
        // A flat rate has no long-context cliff to fall off.
        expect(spark.longContext).toBeUndefined();
    });

    it('the only non-Workers-AI models routed are spark and sol', () => {
        const offCf = [...new Set(routedModels().filter((m) => !m.startsWith('@cf/')))];
        expect(offCf.sort()).toEqual([SPARK_MODEL, 'openai/gpt-5.6-sol'].sort());
    });

    it('glm-5.3 prices strictly below the grok it replaced, with no long-context cliff', () => {
        const glm = MODEL_CATALOG[PLANNER_MODEL]!;
        const grok = MODEL_CATALOG['xai/grok-4.6']!;

        expect(glm.inputCostPer1M).toBeLessThan(grok.inputCostPer1M);
        expect(glm.outputCostPer1M).toBeLessThan(grok.outputCostPer1M);
        expect(glm.cachedInputCostPer1M).toBeLessThan(grok.cachedInputCostPer1M);
        expect(glm.contextWindow).toBeGreaterThan(grok.contextWindow);
        // Grok doubled the price of the whole request above 200k input, at
        // exactly the sizes the Deep Think tier exists to serve.
        expect(grok.longContext).toBeDefined();
        expect(glm.longContext).toBeUndefined();
    });

    it('inline: qwen3-30b', () => {
        expect(DEFAULT_MODEL_ROUTING.inline).toBe('@cf/qwen/qwen3-30b-a3b-fp8');
    });
});
