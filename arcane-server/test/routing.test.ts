import { describe, it, expect } from 'vitest';
import { resolveModelForSend } from '../src/config/routing.ts';
import { INTENSITY_CONFIG, INLINE_MODEL } from '../src/config/plans.ts';

const LOW = INTENSITY_CONFIG.low.model;
const MID = INTENSITY_CONFIG.mid.model;
const HIGH = INTENSITY_CONFIG.high.model;

describe('resolveModelForSend', () => {
    it('flag off → static tier map (identity with old resolveModelForTier)', () => {
        expect(resolveModelForSend('low', {}, undefined).model).toBe(LOW);
        expect(resolveModelForSend('mid', {}, 'off').model).toBe(MID);
        expect(resolveModelForSend('high', {}, undefined).model).toBe(HIGH);
        expect(resolveModelForSend('mid', {}, undefined).reason).toBe('routing-off');
    });

    it('legacy super and garbage tiers fall back safely', () => {
        expect(resolveModelForSend('super', {}, 'on').model).toBe(HIGH);
        expect(resolveModelForSend('garbage', {}, 'on').model).toBe(LOW);
    });

    it('memory side-task always routes to the inline model, flag or no flag', () => {
        expect(resolveModelForSend('high', { taskType: 'memory' }, undefined)).toEqual({
            model: INLINE_MODEL, routedTier: 'low', reason: 'side-task',
        });
        expect(resolveModelForSend('mid', { taskType: 'memory' }, 'on').model).toBe(INLINE_MODEL);
    });

    it('simple short ask downgrades to the low model when the flag is on', () => {
        const signals = { mode: 'ask', taskType: 'chat', promptChars: 120, codeIntent: false, hasAttachments: false };
        const d = resolveModelForSend('high', signals, 'on');
        expect(d).toEqual({ model: LOW, routedTier: 'low', reason: 'simple-ask-downgrade' });
        // low tier: nothing to downgrade to
        expect(resolveModelForSend('low', signals, 'on').reason).toBe('static');
    });

    it('never downgrades code-intent, long, attachment-carrying, or non-ask sends', () => {
        const base = { mode: 'ask', promptChars: 120, codeIntent: false, hasAttachments: false };
        expect(resolveModelForSend('mid', { ...base, codeIntent: true }, 'on').model).toBe(MID);
        expect(resolveModelForSend('mid', { ...base, promptChars: 5000 }, 'on').model).toBe(MID);
        expect(resolveModelForSend('mid', { ...base, hasAttachments: true }, 'on').model).toBe(MID);
        expect(resolveModelForSend('mid', { ...base, mode: 'agent' }, 'on').model).toBe(MID);
        // Missing promptChars (older editor build) must never downgrade.
        expect(resolveModelForSend('mid', { mode: 'ask' }, 'on').model).toBe(MID);
    });
});
