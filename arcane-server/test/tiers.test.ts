import { describe, it, expect } from 'vitest';
import {
    TIERS, MARGIN, GATEWAY_FEE, TOPUP_PACKS,
    INLINE_DAILY_CAP, INLINE_MONTHLY_MICRO_CEILING,
    isTierAllowed, tierGrantMicro,
} from '../src/config/tiers.ts';

describe('margin constants', () => {
    it('are the values the design underwrites', () => {
        expect(GATEWAY_FEE).toBe(1.05);
        expect(MARGIN).toBe(2.0);
    });
});

describe('grants', () => {
    it('are exactly plan price x 100', () => {
        for (const tier of Object.values(TIERS)) {
            if (tier.priceUsd > 0) expect(tier.monthlyCredits).toBe(tier.priceUsd * 100);
        }
        expect(TIERS.free.monthlyCredits).toBe(150);
    });

    it('tierGrantMicro converts credits to micro-USD', () => {
        expect(tierGrantMicro('pro')).toBe(2_000 * 10_000);
        expect(tierGrantMicro('unknown')).toBe(150 * 10_000);
    });
});

// The margin floor is the number the business is underwritten on. Both Dodo
// rate cases, both budgets fully burned.
describe('margin invariant at full burn', () => {
    const DODO = { us: { pct: 0.045, flat: 0.40 }, intl: { pct: 0.06, flat: 0.40 } };

    for (const [region, fee] of Object.entries(DODO)) {
        for (const tier of Object.values(TIERS)) {
            if (tier.priceUsd === 0) continue;
            it(`${tier.id} clears 30% net on ${region} cards`, () => {
                const net = tier.priceUsd - tier.priceUsd * fee.pct - fee.flat;
                const chatCogs = (tier.monthlyCredits / 100) / MARGIN;
                const inlineCogs = INLINE_MONTHLY_MICRO_CEILING[tier.id as keyof typeof INLINE_MONTHLY_MICRO_CEILING] / 1_000_000;
                const margin = (net - chatCogs - inlineCogs) / tier.priceUsd;
                expect(margin).toBeGreaterThanOrEqual(0.30);
            });
        }
    }
});

describe('inline budgets', () => {
    it('free gets $1, paid gets 10% of plan price', () => {
        expect(INLINE_MONTHLY_MICRO_CEILING.free).toBe(1_000_000);
        expect(INLINE_MONTHLY_MICRO_CEILING.pro).toBe(2_000_000);
        expect(INLINE_MONTHLY_MICRO_CEILING.proplus).toBe(5_000_000);
        expect(INLINE_MONTHLY_MICRO_CEILING.ultra).toBe(20_000_000);
    });

    it('daily caps ration the monthly budget across ~30 days', () => {
        for (const plan of ['free', 'pro', 'proplus', 'ultra'] as const) {
            const monthly = INLINE_MONTHLY_MICRO_CEILING[plan];
            const daily = INLINE_DAILY_CAP[plan];
            // 30 days at the cap must not undershoot the budget, nor exceed it
            // by more than 10% (caps are rounded up to clean numbers).
            const perSuggestionMicro = 54.6;
            const monthlyAtCap = daily * 30 * perSuggestionMicro;
            expect(monthlyAtCap).toBeGreaterThan(monthly * 0.9);
            expect(monthlyAtCap).toBeLessThan(monthly * 1.1);
        }
    });
});

describe('tier access', () => {
    it('free may only use low', () => {
        expect(isTierAllowed('free', 'low')).toBe(true);
        expect(isTierAllowed('free', 'mid')).toBe(false);
        expect(isTierAllowed('free', 'high')).toBe(false);
    });

    it('paid plans may use every tier', () => {
        for (const plan of ['pro', 'proplus', 'ultra']) {
            for (const tier of ['low', 'mid', 'high']) {
                expect(isTierAllowed(plan, tier)).toBe(true);
            }
        }
    });

    it('treats an unknown plan as free', () => {
        expect(isTierAllowed('nonsense', 'mid')).toBe(false);
        expect(isTierAllowed('nonsense', 'low')).toBe(true);
    });

    it('maps the legacy super value onto high', () => {
        expect(isTierAllowed('pro', 'super')).toBe(true);
        expect(isTierAllowed('free', 'super')).toBe(false);
    });
});

describe('top-up packs', () => {
    it('price a credit identically to plans', () => {
        for (const pack of TOPUP_PACKS) {
            expect(pack.credits).toBe(pack.priceUsd * 100);
        }
    });
});
