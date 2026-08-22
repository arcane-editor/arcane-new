import { describe, it, expect } from 'vitest';
import { isTierAllowed } from '../src/config/tiers.ts';
import { getIntensityConfig } from '../src/config/plans.ts';

// The gate is pure policy — exercised here directly so it is covered even
// though the test env has no AI binding for a full chat round-trip.
describe('tier gate policy', () => {
    it('blocks free users from Deep Think and Max', () => {
        expect(isTierAllowed('free', 'mid')).toBe(false);
        expect(isTierAllowed('free', 'high')).toBe(false);
    });

    it('lets free users use Standard', () => {
        expect(isTierAllowed('free', 'low')).toBe(true);
    });

    it('resolves the tier before gating so super is gated as high', () => {
        const cfg = getIntensityConfig('super');
        expect(cfg?.label).toBe('Max');
        expect(isTierAllowed('free', 'super')).toBe(false);
        expect(isTierAllowed('max', 'super')).toBe(true);
    });

    // Per-plan matrix for the new ladder: starter is low-only (same as free);
    // pro gets Deep Think but not Max; max gets everything. A later task
    // rewrites routing itself — this only pins entitlement, not model choice.
    it('starter is low-only', () => {
        expect(isTierAllowed('starter', 'low')).toBe(true);
        expect(isTierAllowed('starter', 'mid')).toBe(false);
        expect(isTierAllowed('starter', 'high')).toBe(false);
    });

    it('pro gets Deep Think but not Max', () => {
        expect(isTierAllowed('pro', 'low')).toBe(true);
        expect(isTierAllowed('pro', 'mid')).toBe(true);
        expect(isTierAllowed('pro', 'high')).toBe(false);
    });

    it('max gets every tier', () => {
        expect(isTierAllowed('max', 'low')).toBe(true);
        expect(isTierAllowed('max', 'mid')).toBe(true);
        expect(isTierAllowed('max', 'high')).toBe(true);
    });

    it('reaching high/super needs max — pro is not enough', () => {
        expect(isTierAllowed('pro', 'high')).toBe(false);
        expect(isTierAllowed('pro', 'super')).toBe(false);
        expect(isTierAllowed('max', 'super')).toBe(true);
    });
});
