import { describe, it, expect } from 'vitest';
import { resolveInitialTab } from './account-tab';

describe('resolveInitialTab', () => {
    it('opens Billing for #billing and Account for anything else', () => {
        expect(resolveInitialTab('', '#billing')).toBe('billing');
        expect(resolveInitialTab('', '#account')).toBe('account');
        expect(resolveInitialTab('', '')).toBe('account');
        expect(resolveInitialTab('', '#nonsense')).toBe('account');
    });

    it('opens Billing when returning from a successful checkout', () => {
        // Dodo returns to /account?checkout=success with NO hash. The
        // "Payment received" notice lives in the billing panel, so landing on
        // the Account tab would leave it unmounted and swallow the receipt.
        expect(resolveInitialTab('?checkout=success', '')).toBe('billing');
    });

    it('lets the checkout return override an explicit #account', () => {
        expect(resolveInitialTab('?checkout=success', '#account')).toBe('billing');
    });

    it('ignores a checkout param that is not a success', () => {
        expect(resolveInitialTab('?checkout=cancelled', '')).toBe('account');
        expect(resolveInitialTab('?checkout=cancelled', '#billing')).toBe('billing');
    });

    it('tolerates other query params alongside it', () => {
        expect(resolveInitialTab('?foo=1&checkout=success&bar=2', '')).toBe('billing');
    });
});
