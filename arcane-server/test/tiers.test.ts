import { describe, it, expect } from 'vitest';
import {
    TIERS, MARGIN, GATEWAY_FEE, TOPUP_PACKS, SIGNUP_TRIAL_MICRO,
    INLINE_DAILY_CAP, INLINE_MONTHLY_MICRO_CEILING,
    isTierAllowed, minPlanForTier, tierGrantMicro, isPaidPlan, creditsToMicro,
} from '../src/config/tiers.ts';

describe('margin constants', () => {
    it('are the values the design underwrites', () => {
        expect(GATEWAY_FEE).toBe(1.05);
        // Margin no longer lives at debit time — it lives in the grant
        // holdback (10%) and the top-up markup (20%). MARGIN is a no-op left
        // in place as a debit-time lever, not removed.
        expect(MARGIN).toBe(1.0);
    });
});

describe('grants', () => {
    it('paid grants are plan price minus the owner cut minus Dodo fees', () => {
        // floor((priceUsd * (1 - 0.10 - 0.045) - 0.40) * 100)
        expect(TIERS.starter.monthlyCredits).toBe(Math.floor((5 * 0.855 - 0.40) * 100));
        expect(TIERS.pro.monthlyCredits).toBe(Math.floor((25 * 0.855 - 0.40) * 100));
        expect(TIERS.max.monthlyCredits).toBe(Math.floor((50 * 0.855 - 0.40) * 100));
        expect(TIERS.starter.monthlyCredits).toBe(387);
        expect(TIERS.pro.monthlyCredits).toBe(2097);
        expect(TIERS.max.monthlyCredits).toBe(4235);
    });

    it('free is a one-time signup trial, not a monthly grant', () => {
        expect(TIERS.free.monthlyCredits).toBe(150);
        expect(SIGNUP_TRIAL_MICRO).toBe(1_500_000);
        expect(SIGNUP_TRIAL_MICRO).toBe(creditsToMicro(TIERS.free.monthlyCredits));
    });

    it('tierGrantMicro converts credits to micro-USD', () => {
        expect(tierGrantMicro('pro')).toBe(2_097 * 10_000);
        expect(tierGrantMicro('unknown')).toBe(150 * 10_000);
    });
});

describe('inline budgets', () => {
    it('free is a feature lock (0); paid gets 10% of plan price in micro-USD', () => {
        expect(INLINE_MONTHLY_MICRO_CEILING).toEqual({
            free: 0, starter: 500_000, pro: 2_500_000, max: 5_000_000,
        });
    });

    it('daily caps are pinned', () => {
        expect(INLINE_DAILY_CAP).toEqual({ free: 0, starter: 300, pro: 1500, max: 3000 });
    });
});

describe('tier access', () => {
    it('free may only use low', () => {
        expect(isTierAllowed('free', 'low')).toBe(true);
        expect(isTierAllowed('free', 'mid')).toBe(false);
        expect(isTierAllowed('free', 'high')).toBe(false);
    });

    it('starter is low-only, same as free', () => {
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
        for (const tier of ['low', 'mid', 'high']) {
            expect(isTierAllowed('max', tier)).toBe(true);
        }
    });

    it('treats an unknown plan as free', () => {
        expect(isTierAllowed('nonsense', 'mid')).toBe(false);
        expect(isTierAllowed('nonsense', 'low')).toBe(true);
    });

    it('maps the legacy super value onto high, gated like high', () => {
        expect(isTierAllowed('pro', 'super')).toBe(false); // pro has no high/super
        expect(isTierAllowed('max', 'super')).toBe(true);
        expect(isTierAllowed('free', 'super')).toBe(false);
    });
});

describe('minPlanForTier', () => {
    it('maps each effort tier to the lowest plan that grants it', () => {
        expect(minPlanForTier('low')).toBe('free');
        expect(minPlanForTier('mid')).toBe('pro');
        expect(minPlanForTier('high')).toBe('max');
    });

    it('normalizes the legacy super value onto high', () => {
        expect(minPlanForTier('super')).toBe('max');
    });

    it('falls back to free for a tier no plan grants', () => {
        expect(minPlanForTier('garbage')).toBe('free');
        expect(minPlanForTier('')).toBe('free');
    });
});

describe('top-up packs', () => {
    it('carry a 20% markup: credits = floor(priceUsd x 100 / 1.2)', () => {
        for (const pack of TOPUP_PACKS) {
            expect(pack.credits).toBe(Math.floor(pack.priceUsd * 100 / 1.2));
        }
    });

    it('pins the exact ids, prices, credits and product vars', () => {
        expect(TOPUP_PACKS).toEqual([
            { id: 'topup_16', credits: 1333, priceUsd: 16, dodoProductVar: 'DODO_PRODUCT_TOPUP_16' },
            { id: 'topup_75', credits: 6250, priceUsd: 75, dodoProductVar: 'DODO_PRODUCT_TOPUP_75' },
        ]);
    });
});

describe('isPaidPlan', () => {
    it('is true only for known tiers that cost money', () => {
        expect(isPaidPlan('starter')).toBe(true);
        expect(isPaidPlan('pro')).toBe(true);
        expect(isPaidPlan('max')).toBe(true);
        expect(isPaidPlan('free')).toBe(false);
    });

    it('fails closed on unknown plan values', () => {
        expect(isPaidPlan('enterprise')).toBe(false);
        expect(isPaidPlan('')).toBe(false);
        // Retired tier ids are unknown now, not paid.
        expect(isPaidPlan('proplus')).toBe(false);
        expect(isPaidPlan('ultra')).toBe(false);
    });

    it('agrees with the tier table rather than a hardcoded list', () => {
        for (const tier of Object.values(TIERS)) {
            expect(isPaidPlan(tier.id)).toBe(tier.priceUsd > 0);
        }
    });
});
