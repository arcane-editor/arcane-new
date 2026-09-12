import { describe, it, expect } from 'vitest';
import { resolveModelForSend } from '../src/config/routing.ts';
import { DEFAULT_INTENSITY, DEFAULT_MODEL_ROUTING } from '../src/config/plans.ts';
import type { ModelRoutingDoc } from '../src/lib/app-config.ts';

// Pure-function suite: routing.ts takes an already-resolved ModelRoutingDoc,
// so these fixtures use distinguishable placeholder ids per role/tier rather
// than real catalog entries — resolveModelForSend never looks the ids up
// anywhere, it only picks which field of the doc to return.
const DOC: ModelRoutingDoc = {
    tiers: {
        low:  { planner: 'low-planner', executor: 'low-executor' },
        mid:  { planner: 'mid-planner', executor: 'mid-executor' },
        high: { planner: 'high-planner', executor: 'high-executor', executorHard: 'high-executor-hard' },
    },
    inline: 'inline-model',
};

// Same shape but the high tier has no executorHard — the "absent" branch.
const DOC_NO_HARD: ModelRoutingDoc = {
    tiers: {
        low:  { planner: 'low-planner', executor: 'low-executor' },
        mid:  { planner: 'mid-planner', executor: 'mid-executor' },
        high: { planner: 'high-planner', executor: 'high-executor' },
    },
    inline: 'inline-model',
};

describe('resolveModelForSend', () => {
    it('executor is the default for each tier with no signals', () => {
        expect(resolveModelForSend('low', {}, DOC)).toEqual({ model: 'low-executor', routedTier: 'low', reason: 'executor', effort: 'xhigh' });
        expect(resolveModelForSend('mid', {}, DOC)).toEqual({ model: 'mid-executor', routedTier: 'mid', reason: 'executor', effort: 'xhigh' });
        expect(resolveModelForSend('high', {}, DOC)).toEqual({ model: 'high-executor', routedTier: 'high', reason: 'executor', effort: 'xhigh' });
    });

    it('planner is served on both planning and preplanning, for every tier', () => {
        for (const tier of ['low', 'mid', 'high'] as const) {
            expect(resolveModelForSend(tier, { planPhase: 'planning' }, DOC)).toEqual({
                model: `${tier}-planner`, routedTier: tier, reason: 'planner', effort: 'xhigh',
            });
            expect(resolveModelForSend(tier, { planPhase: 'preplanning' }, DOC)).toEqual({
                model: `${tier}-planner`, routedTier: tier, reason: 'planner', effort: 'xhigh',
            });
        }
    });

    it('planPhase "executing" is not the planner phase — falls through to executor', () => {
        expect(resolveModelForSend('mid', { planPhase: 'executing' }, DOC).reason).toBe('executor');
        expect(resolveModelForSend('mid', { planPhase: 'executing' }, DOC).model).toBe('mid-executor');
    });

    it('memory side-task always routes to the doc\'s inline model, regardless of tier', () => {
        for (const tier of ['low', 'mid', 'high']) {
            expect(resolveModelForSend(tier, { taskType: 'memory' }, DOC)).toEqual({
                model: 'inline-model', routedTier: 'low', reason: 'side-task',
            });
        }
        // Beats planPhase/difficulty too — side-task lane wins regardless.
        expect(resolveModelForSend('high', { taskType: 'memory', planPhase: 'planning', difficulty: 'hard' }, DOC).reason)
            .toBe('side-task');
    });

    describe('executorHard (high tier only)', () => {
        it('routes to executorHard when tier is high, difficulty is hard, and the doc has one', () => {
            expect(resolveModelForSend('high', { difficulty: 'hard' }, DOC)).toEqual({
                model: 'high-executor-hard', routedTier: 'high', reason: 'executor-hard', effort: 'xhigh',
            });
        });

        it('falls back to executor when the doc has no executorHard for high', () => {
            expect(resolveModelForSend('high', { difficulty: 'hard' }, DOC_NO_HARD)).toEqual({
                model: 'high-executor', routedTier: 'high', reason: 'executor', effort: 'xhigh',
            });
        });

        it('"easy" difficulty on high stays on executor', () => {
            expect(resolveModelForSend('high', { difficulty: 'easy' }, DOC)).toEqual({
                model: 'high-executor', routedTier: 'high', reason: 'executor', effort: 'xhigh',
            });
        });

        it('absent difficulty on high stays on executor', () => {
            expect(resolveModelForSend('high', {}, DOC).reason).toBe('executor');
        });

        it('difficulty is ignored on low and mid — always executor', () => {
            expect(resolveModelForSend('low', { difficulty: 'hard' }, DOC)).toEqual({
                model: 'low-executor', routedTier: 'low', reason: 'executor', effort: 'xhigh',
            });
            expect(resolveModelForSend('mid', { difficulty: 'hard' }, DOC)).toEqual({
                model: 'mid-executor', routedTier: 'mid', reason: 'executor', effort: 'xhigh',
            });
        });
    });

    describe('tier resolution', () => {
        it('legacy "super" resolves to the high ladder', () => {
            expect(resolveModelForSend('super', {}, DOC)).toEqual({ model: 'high-executor', routedTier: 'high', reason: 'executor', effort: 'xhigh' });
            expect(resolveModelForSend('super', { difficulty: 'hard' }, DOC).reason).toBe('executor-hard');
            expect(resolveModelForSend('super', { planPhase: 'planning' }, DOC).model).toBe('high-planner');
        });

        it('an unrecognised tier falls back to DEFAULT_INTENSITY\'s ladder', () => {
            const fallback = resolveModelForSend('garbage', {}, DOC);
            const expected = resolveModelForSend(DEFAULT_INTENSITY, {}, DOC);
            expect(fallback).toEqual(expected);
            expect(fallback.routedTier).toBe(DEFAULT_INTENSITY);
        });
    });
});

// ─── Reasoning effort ─────────────────────────────────────────
//
// Effort is resolved from the same (tier, role) pair the model is, then
// CLAMPED: only spark models may run at 'max'. The fixtures below therefore
// come in two flavours — SPARK_DOC, where every slot is a spark id and the
// role intent survives, and DOC above, where none are and everything falls to
// 'xhigh'. The clamp is the whole reason both exist.
const SPARK = 'spark/muse-spark-1.3-contributor';

const SPARK_DOC: ModelRoutingDoc = {
    tiers: {
        low:  { planner: SPARK, executor: SPARK },
        mid:  { planner: SPARK, executor: SPARK },
        high: { planner: SPARK, executor: SPARK, executorHard: SPARK },
    },
    inline: 'inline-model',
};

describe('resolveModelForSend: reasoning effort', () => {
    it('standard: the planner thinks at max effort, the executor at xhigh', () => {
        expect(resolveModelForSend('low', { planPhase: 'planning' }, SPARK_DOC).effort).toBe('max');
        expect(resolveModelForSend('low', { planPhase: 'preplanning' }, SPARK_DOC).effort).toBe('max');
        expect(resolveModelForSend('low', {}, SPARK_DOC).effort).toBe('xhigh');
    });

    it('deep think follows the same rule as standard', () => {
        expect(resolveModelForSend('mid', { planPhase: 'planning' }, SPARK_DOC).effort).toBe('max');
        expect(resolveModelForSend('mid', {}, SPARK_DOC).effort).toBe('xhigh');
    });

    it('max inverts it: execution is the max-effort role, everything else is xhigh', () => {
        expect(resolveModelForSend('high', {}, SPARK_DOC).effort).toBe('max');
        expect(resolveModelForSend('high', { planPhase: 'planning' }, SPARK_DOC).effort).toBe('xhigh');
        expect(resolveModelForSend('high', { difficulty: 'hard' }, SPARK_DOC).effort).toBe('xhigh');
    });

    it('legacy "super" gets the high ladder\'s effort too', () => {
        expect(resolveModelForSend('super', {}, SPARK_DOC).effort).toBe('max');
    });

    // The clamp. 'max' is a spark-only level; every other provider is pinned
    // to xhigh (or its nearest equivalent, mapped per wire in llm-router).
    it('clamps a non-spark model in a max-effort slot down to xhigh', () => {
        expect(resolveModelForSend('low', { planPhase: 'planning' }, DOC).effort).toBe('xhigh');
        expect(resolveModelForSend('high', {}, DOC).effort).toBe('xhigh');
    });

    it('clamps per slot, not per tier — a mixed doc keeps max only where spark serves', () => {
        const mixed: ModelRoutingDoc = {
            tiers: {
                low:  { planner: SPARK, executor: 'low-executor' },
                mid:  { planner: 'mid-planner', executor: SPARK },
                high: { planner: 'high-planner', executor: SPARK, executorHard: 'high-executor-hard' },
            },
            inline: 'inline-model',
        };
        expect(resolveModelForSend('low', { planPhase: 'planning' }, mixed).effort).toBe('max');
        expect(resolveModelForSend('mid', { planPhase: 'planning' }, mixed).effort).toBe('xhigh');
        expect(resolveModelForSend('high', {}, mixed).effort).toBe('max');
    });

    // The memory lane runs on the cheap inline model and exists to stay cheap;
    // spending reasoning tokens on it would defeat the point of the lane.
    it('sends no effort at all on the memory side-task lane', () => {
        expect(resolveModelForSend('high', { taskType: 'memory' }, SPARK_DOC).effort).toBeUndefined();
    });
});

// What the shipped lineup actually resolves to — the table the owner asked
// for, asserted end-to-end against the real code-default doc rather than a
// fixture, so a routing edit that silently changes an effort fails here.
describe('effort matrix over DEFAULT_MODEL_ROUTING', () => {
    it('standard: spark plans at max, executes at xhigh', () => {
        expect(resolveModelForSend('low', { planPhase: 'planning' }, DEFAULT_MODEL_ROUTING).effort).toBe('max');
        expect(resolveModelForSend('low', {}, DEFAULT_MODEL_ROUTING).effort).toBe('xhigh');
    });

    // mid.planner is glm-5.3, not spark, so the max intent is clamped away —
    // this flips to 'max' by itself the day spark takes that slot.
    it('deep think: clamped to xhigh in both roles while its planner is not spark', () => {
        expect(resolveModelForSend('mid', { planPhase: 'planning' }, DEFAULT_MODEL_ROUTING).effort).toBe('xhigh');
        expect(resolveModelForSend('mid', {}, DEFAULT_MODEL_ROUTING).effort).toBe('xhigh');
    });

    it('max: spark executes at max, sol plans and glm-5.3 handles hard sends at xhigh', () => {
        expect(resolveModelForSend('high', {}, DEFAULT_MODEL_ROUTING).effort).toBe('max');
        expect(resolveModelForSend('high', { planPhase: 'planning' }, DEFAULT_MODEL_ROUTING).effort).toBe('xhigh');
        expect(resolveModelForSend('high', { difficulty: 'hard' }, DEFAULT_MODEL_ROUTING).effort).toBe('xhigh');
    });
});
