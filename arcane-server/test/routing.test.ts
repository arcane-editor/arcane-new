import { describe, it, expect } from 'vitest';
import { resolveModelForSend } from '../src/config/routing.ts';
import { DEFAULT_INTENSITY } from '../src/config/plans.ts';
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
        expect(resolveModelForSend('low', {}, DOC)).toEqual({ model: 'low-executor', routedTier: 'low', reason: 'executor' });
        expect(resolveModelForSend('mid', {}, DOC)).toEqual({ model: 'mid-executor', routedTier: 'mid', reason: 'executor' });
        expect(resolveModelForSend('high', {}, DOC)).toEqual({ model: 'high-executor', routedTier: 'high', reason: 'executor' });
    });

    it('planner is served on both planning and preplanning, for every tier', () => {
        for (const tier of ['low', 'mid', 'high'] as const) {
            expect(resolveModelForSend(tier, { planPhase: 'planning' }, DOC)).toEqual({
                model: `${tier}-planner`, routedTier: tier, reason: 'planner',
            });
            expect(resolveModelForSend(tier, { planPhase: 'preplanning' }, DOC)).toEqual({
                model: `${tier}-planner`, routedTier: tier, reason: 'planner',
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
                model: 'high-executor-hard', routedTier: 'high', reason: 'executor-hard',
            });
        });

        it('falls back to executor when the doc has no executorHard for high', () => {
            expect(resolveModelForSend('high', { difficulty: 'hard' }, DOC_NO_HARD)).toEqual({
                model: 'high-executor', routedTier: 'high', reason: 'executor',
            });
        });

        it('"easy" difficulty on high stays on executor', () => {
            expect(resolveModelForSend('high', { difficulty: 'easy' }, DOC)).toEqual({
                model: 'high-executor', routedTier: 'high', reason: 'executor',
            });
        });

        it('absent difficulty on high stays on executor', () => {
            expect(resolveModelForSend('high', {}, DOC).reason).toBe('executor');
        });

        it('difficulty is ignored on low and mid — always executor', () => {
            expect(resolveModelForSend('low', { difficulty: 'hard' }, DOC)).toEqual({
                model: 'low-executor', routedTier: 'low', reason: 'executor',
            });
            expect(resolveModelForSend('mid', { difficulty: 'hard' }, DOC)).toEqual({
                model: 'mid-executor', routedTier: 'mid', reason: 'executor',
            });
        });
    });

    describe('tier resolution', () => {
        it('legacy "super" resolves to the high ladder', () => {
            expect(resolveModelForSend('super', {}, DOC)).toEqual({ model: 'high-executor', routedTier: 'high', reason: 'executor' });
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
