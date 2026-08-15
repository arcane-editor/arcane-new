import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { seedPasswordUser, tokenFor } from './helpers.ts';

/**
 * Grounding search cache (spec §6, migration 0021). A cache HIT must serve
 * the stored response without touching the AI/Vectorize bindings — which the
 * test pool doesn't have, so a hit succeeding here proves the embed was
 * skipped (a miss would fall into the embed path and fail on the absent
 * binding).
 */

// Mirror of the route's key derivation (kept in sync by the round-trip test
// below hitting the real route).
async function keyFor(parts: Record<string, unknown>): Promise<string> {
    const canonical = JSON.stringify(parts, Object.keys(parts).sort());
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('unity search cache', () => {
    it('a seeded cache row is served without any AI/Vectorize call', async () => {
        const user = await seedPasswordUser('search-cache@test.dev', 'password123');
        const token = await tokenFor(user);

        const cached = { version: '6000.3', source: 'vectorize', results: [{ score: 0.9, docType: 'scriptref', text: 'cached hit' }] };
        const cacheKey = await keyFor({
            q: 'rigidbody addforce',
            v: '6000.3',
            rp: 'URP',
            is: 'New',
            dt: 'all',
            topK: 8,
        });
        await env.arcane_db
            .prepare('INSERT INTO unity_search_cache (cache_key, response, expires_at) VALUES (?, ?, ?)')
            .bind(cacheKey, JSON.stringify(cached), Date.now() + 60_000)
            .run();

        const res = await SELF.fetch('https://example.com/v1/unity/api/search', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                // Route normalizes: trim + lowercase query, major.minor version.
                query: '  Rigidbody AddForce ',
                unityVersion: '6000.3.5f2',
                renderPipeline: 'URP',
                inputSystem: 'New',
            }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(cached);
    });

    it('an expired row is ignored (falls through to the live path)', async () => {
        const user = await seedPasswordUser('search-cache-exp@test.dev', 'password123');
        const token = await tokenFor(user);

        const cacheKey = await keyFor({ q: 'expired query', v: '6000.3', rp: '', is: '', dt: 'all', topK: 8 });
        await env.arcane_db
            .prepare('INSERT INTO unity_search_cache (cache_key, response, expires_at) VALUES (?, ?, ?)')
            .bind(cacheKey, JSON.stringify({ version: '6000.3', source: 'vectorize', results: [{ text: 'stale' }] }), Date.now() - 1)
            .run();

        const res = await SELF.fetch('https://example.com/v1/unity/api/search', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: 'expired query', unityVersion: '6000.3.5f2' }),
        });
        // Live path runs: with no AI binding + no seeded signatures the route
        // ends in its 500 fallback — the point is it must NOT serve `stale`.
        if (res.status === 200) {
            const body = (await res.json()) as { results?: Array<{ text?: string }> };
            expect(body.results?.some((r) => r.text === 'stale')).toBeFalsy();
        } else {
            expect(res.status).toBe(500);
        }
    });
});
