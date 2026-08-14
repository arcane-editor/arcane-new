import { describe, it, expect } from 'bun:test';
import { useInlineSuggestStore } from './inline-suggest';

describe('inline-suggest store', () => {
    it('defaults to active with no quota reset', () => {
        const s = useInlineSuggestStore.getState();
        expect(s.status).toBe('active');
        expect(s.quotaResetAt).toBeNull();
    });

    it('setStatus stores quota resetAt only for quota status', () => {
        useInlineSuggestStore.getState().setStatus('quota', '2099-01-01T00:00:00.000Z');
        expect(useInlineSuggestStore.getState().quotaResetAt).toBe('2099-01-01T00:00:00.000Z');
        useInlineSuggestStore.getState().setStatus('active');
        expect(useInlineSuggestStore.getState().quotaResetAt).toBeNull();
    });

    it('quotaActive is true only while status=quota and resetAt is in the future', () => {
        const store = useInlineSuggestStore.getState();
        store.setStatus('quota', '2099-01-01T00:00:00.000Z');
        expect(useInlineSuggestStore.getState().quotaActive()).toBe(true);
        store.setStatus('quota', '2000-01-01T00:00:00.000Z');
        expect(useInlineSuggestStore.getState().quotaActive()).toBe(false);
        store.setStatus('active');
        expect(useInlineSuggestStore.getState().quotaActive()).toBe(false);
    });

    // 402 inline_budget_exhausted (the monthly spend ceiling) is a second,
    // independent pause condition alongside the 429 daily 'quota' — same
    // resetAt-tracking/gating behavior, distinct status for distinct copy.
    it('setStatus stores resetAt for budget-exhausted too, same as quota', () => {
        useInlineSuggestStore.getState().setStatus('budget-exhausted', '2099-02-01T00:00:00.000Z');
        expect(useInlineSuggestStore.getState().quotaResetAt).toBe('2099-02-01T00:00:00.000Z');
        useInlineSuggestStore.getState().setStatus('active');
        expect(useInlineSuggestStore.getState().quotaResetAt).toBeNull();
    });

    it('quotaActive is true while status=budget-exhausted and resetAt is in the future', () => {
        const store = useInlineSuggestStore.getState();
        store.setStatus('budget-exhausted', '2099-02-01T00:00:00.000Z');
        expect(useInlineSuggestStore.getState().quotaActive()).toBe(true);
        store.setStatus('budget-exhausted', '2000-01-01T00:00:00.000Z');
        expect(useInlineSuggestStore.getState().quotaActive()).toBe(false);
    });
});
