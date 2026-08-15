/** Sections of the /account page. */
export type TabId = 'account' | 'billing';

/**
 * Which tab /account should open on, from the URL alone.
 *
 * Pure so the routing rules can be tested without a DOM — the interesting case
 * has no hash at all and is easy to regress.
 *
 * Precedence: a successful Dodo checkout wins over the hash. Dodo returns the
 * customer to `/account?checkout=success`, and the "Payment received" notice
 * lives in the billing panel; opening the Account tab would leave that panel
 * unmounted and the customer would see no confirmation at all.
 */
export function resolveInitialTab(search: string, hash: string): TabId {
    if (new URLSearchParams(search).get('checkout') === 'success') {
        return 'billing';
    }
    return hash.slice(1) === 'billing' ? 'billing' : 'account';
}
