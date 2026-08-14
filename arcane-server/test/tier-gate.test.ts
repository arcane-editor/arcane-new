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
        expect(isTierAllowed('pro', 'super')).toBe(true);
    });
});
