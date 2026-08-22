import { describe, it, expect } from 'bun:test';
import { createPlanGrantsClient } from './plan-grants';

const ok = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// The exact /v1/billing/plans shape (arcane-server/src/routes/billing.ts).
const PLANS_BODY = {
    tiers: [
        { id: 'free', name: 'Free', priceUsd: 0, monthlyCredits: 150, order: 0 },
        { id: 'starter', name: 'Starter', priceUsd: 5, monthlyCredits: 387, order: 1 },
        { id: 'pro', name: 'Pro', priceUsd: 25, monthlyCredits: 2097, order: 2 },
        { id: 'max', name: 'Max', priceUsd: 50, monthlyCredits: 4235, order: 3 },
    ],
    topups: [{ id: 'small', credits: 500, priceUsd: 5 }],
};

function clientWith(fetchImpl: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) {
    return createPlanGrantsClient({ fetchImpl: fetchImpl as unknown as typeof fetch, baseUrl: 'https://x.test' });
}

describe('planGrantsClient.getGrant', () => {
    it('returns the grant for a known plan', async () => {
        const c = clientWith(async () => ok(PLANS_BODY));
        expect(await c.getGrant('pro')).toBe(2097);
        expect(await c.getGrant('free')).toBe(150);
    });

    it('returns 0 for a plan id not in the ladder (unknown/legacy) once the fetch has succeeded', async () => {
        const c = clientWith(async () => ok(PLANS_BODY));
        expect(await c.getGrant('some-legacy-plan')).toBe(0);
    });

    it('returns null while the fetch has not resolved yet (a failure) — never guesses', async () => {
        const c = clientWith(async () => ok({}, 500));
        expect(await c.getGrant('pro')).toBeNull();
    });

    it('returns null on a network error too', async () => {
        const c = clientWith(async () => { throw new TypeError('offline'); });
        expect(await c.getGrant('pro')).toBeNull();
    });

    it('caches after the first success — a second call does not refetch', async () => {
        let calls = 0;
        const c = clientWith(async () => { calls += 1; return ok(PLANS_BODY); });
        await c.getGrant('pro');
        await c.getGrant('starter');
        await c.getGrant('free');
        expect(calls).toBe(1);
    });

    it('concurrent calls before the first resolution share ONE in-flight fetch (single-flight)', async () => {
        let calls = 0;
        const c = clientWith(async () => {
            calls += 1;
            await new Promise((r) => setTimeout(r, 5));
            return ok(PLANS_BODY);
        });
        const [a, b] = await Promise.all([c.getGrant('pro'), c.getGrant('max')]);
        expect(calls).toBe(1);
        expect(a).toBe(2097);
        expect(b).toBe(4235);
    });

    it('a failure does not poison the cache — the NEXT call retries and can succeed', async () => {
        let attempt = 0;
        const c = clientWith(async () => {
            attempt += 1;
            return attempt === 1 ? ok({}, 500) : ok(PLANS_BODY);
        });
        expect(await c.getGrant('pro')).toBeNull();
        expect(await c.getGrant('pro')).toBe(2097);
        expect(attempt).toBe(2);
    });
});
