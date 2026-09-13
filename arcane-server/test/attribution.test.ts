import { describe, it, expect } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import {
    sanitizeToken,
    redditAttributionFrom,
    redditAttributionFromQuery,
    hasAttribution,
} from '../src/lib/attribution.ts';
import { setUserRedditAttribution } from '../src/lib/db.ts';
import { seedPasswordUser } from './helpers.ts';

/**
 * Reddit ad attribution: how a click id gets from an ad landing page onto an
 * account, and what the server refuses to believe about it on the way.
 */

describe('sanitizeToken', () => {
    it('accepts a Reddit-shaped token', () => {
        expect(sanitizeToken('eyJhbGciOi-_.123')).toBe('eyJhbGciOi-_.123');
    });

    it('trims surrounding whitespace', () => {
        expect(sanitizeToken('  abc  ')).toBe('abc');
    });

    /**
     * `/v1/auth/signup` is public, so the website's own sanitizing is a
     * convenience and this is the check that counts. These values reach a D1
     * column, an admin listing and a third-party request body.
     */
    it.each([
        ['empty', ''],
        ['whitespace', '   '],
        ['a number', 42],
        ['an object', { evil: true }],
        ['null', null],
        ['undefined', undefined],
        ['SQL punctuation', "abc'; DROP TABLE users;--"],
        ['angle brackets', '<script>alert(1)</script>'],
        ['a newline', 'abc\ndef'],
        ['spaces', 'abc def'],
    ])('rejects %s', (_label, input) => {
        expect(sanitizeToken(input)).toBeNull();
    });

    it('rejects an over-long token', () => {
        expect(sanitizeToken('a'.repeat(513))).toBeNull();
        expect(sanitizeToken('a'.repeat(512))).toBe('a'.repeat(512));
    });
});

describe('redditAttributionFrom', () => {
    it('reads both identifiers out of a signup body', () => {
        expect(redditAttributionFrom({ rdtCid: 'click-1', rdtUuid: 'uuid-1' }))
            .toEqual({ clickId: 'click-1', rdtUuid: 'uuid-1' });
    });

    it('yields nulls for an organic signup', () => {
        expect(redditAttributionFrom({ email: 'a@b.dev' }))
            .toEqual({ clickId: null, rdtUuid: null });
    });

    it('drops a hostile value instead of storing it', () => {
        expect(redditAttributionFrom({ rdtCid: "x'; DROP TABLE users;--" }).clickId).toBeNull();
    });
});

describe('redditAttributionFromQuery', () => {
    it('reads the identifiers an OAuth start carries in its query string', () => {
        const attribution = redditAttributionFromQuery(
            'https://api.unityide.app/v1/auth/github/start?return_to=%2Fauth&rdt_cid=click-1&rdt_uuid=uuid-1',
        );
        expect(attribution).toEqual({ clickId: 'click-1', rdtUuid: 'uuid-1' });
    });

    it('yields nulls when the flow started without an ad click', () => {
        expect(redditAttributionFromQuery('https://api.unityide.app/v1/auth/github/start?return_to=%2Fauth'))
            .toEqual({ clickId: null, rdtUuid: null });
    });
});

describe('hasAttribution', () => {
    it('is true when either identifier is present', () => {
        expect(hasAttribution({ clickId: 'c', rdtUuid: null })).toBe(true);
        expect(hasAttribution({ clickId: null, rdtUuid: 'u' })).toBe(true);
    });

    it('is false when neither is', () => {
        expect(hasAttribution({ clickId: null, rdtUuid: null })).toBe(false);
    });
});

describe('setUserRedditAttribution', () => {
    async function attributionOf(userId: number) {
        return env.arcane_db
            .prepare('SELECT rdt_click_id, rdt_uuid FROM users WHERE id = ?')
            .bind(userId)
            .first<{ rdt_click_id: string | null; rdt_uuid: string | null }>();
    }

    it('stores the click that won the account', async () => {
        const user = await seedPasswordUser(`attr-${crypto.randomUUID()}@test.dev`, 'password123');
        await setUserRedditAttribution(env.arcane_db, user.id, { clickId: 'click-1', rdtUuid: 'uuid-1' });

        expect(await attributionOf(user.id)).toEqual({ rdt_click_id: 'click-1', rdt_uuid: 'uuid-1' });
    });

    /**
     * The COALESCE. A later sign-in from a different ad must not rewrite the
     * provenance of an account an earlier campaign actually won — otherwise a
     * Purchase months later is credited to the wrong campaign.
     */
    it('keeps the FIRST click id, not the most recent one', async () => {
        const user = await seedPasswordUser(`attr-${crypto.randomUUID()}@test.dev`, 'password123');
        await setUserRedditAttribution(env.arcane_db, user.id, { clickId: 'first', rdtUuid: null });
        await setUserRedditAttribution(env.arcane_db, user.id, { clickId: 'second', rdtUuid: null });

        expect((await attributionOf(user.id))!.rdt_click_id).toBe('first');
    });

    it('cannot erase what is already known by passing null', async () => {
        const user = await seedPasswordUser(`attr-${crypto.randomUUID()}@test.dev`, 'password123');
        await setUserRedditAttribution(env.arcane_db, user.id, { clickId: 'kept', rdtUuid: 'kept-uuid' });
        await setUserRedditAttribution(env.arcane_db, user.id, { clickId: null, rdtUuid: null });

        expect(await attributionOf(user.id)).toEqual({ rdt_click_id: 'kept', rdt_uuid: 'kept-uuid' });
    });

    it('fills in a field that was missing the first time', async () => {
        const user = await seedPasswordUser(`attr-${crypto.randomUUID()}@test.dev`, 'password123');
        await setUserRedditAttribution(env.arcane_db, user.id, { clickId: 'click-1', rdtUuid: null });
        await setUserRedditAttribution(env.arcane_db, user.id, { clickId: null, rdtUuid: 'uuid-late' });

        expect(await attributionOf(user.id)).toEqual({ rdt_click_id: 'click-1', rdt_uuid: 'uuid-late' });
    });
});

describe('POST /v1/auth/signup — Reddit attribution', () => {
    function signup(body: Record<string, unknown>) {
        return SELF.fetch('https://example.com/v1/auth/signup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    async function userByEmail(email: string) {
        return env.arcane_db
            .prepare('SELECT * FROM users WHERE email = ?')
            .bind(email)
            .first<Record<string, unknown>>();
    }

    async function conversionsFor(userId: number) {
        const result = await env.arcane_db
            .prepare('SELECT * FROM reddit_conversions WHERE user_id = ?')
            .bind(userId)
            .all<Record<string, unknown>>();
        return result.results;
    }

    it('binds the ad click to the new account', async () => {
        const email = `signup-${crypto.randomUUID()}@test.dev`;
        const res = await signup({ email, password: 'password123', rdtCid: 'click-xyz', rdtUuid: 'uuid-xyz' });
        expect(res.status).toBe(200);

        const user = await userByEmail(email);
        expect(user!.rdt_click_id).toBe('click-xyz');
        expect(user!.rdt_uuid).toBe('uuid-xyz');
    });

    it('reports exactly one SignUp conversion', async () => {
        const email = `signup-${crypto.randomUUID()}@test.dev`;
        await signup({ email, password: 'password123', rdtCid: 'click-1' });

        const user = await userByEmail(email);
        const rows = await conversionsFor(user!.id as number);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.event_name).toBe('SignUp');
        expect(rows[0]!.click_id).toBe('click-1');
    });

    /** Organic signups still convert — Reddit matches on the hashed email. */
    it('still reports a SignUp when there is no ad click at all', async () => {
        const email = `organic-${crypto.randomUUID()}@test.dev`;
        await signup({ email, password: 'password123' });

        const user = await userByEmail(email);
        expect(user!.rdt_click_id).toBeNull();

        const rows = await conversionsFor(user!.id as number);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.event_name).toBe('SignUp');
        expect(rows[0]!.click_id).toBeNull();
    });

    it('ignores a hostile click id without failing the signup', async () => {
        const email = `hostile-${crypto.randomUUID()}@test.dev`;
        const res = await signup({ email, password: 'password123', rdtCid: "x'; DROP TABLE users;--" });

        expect(res.status).toBe(200);
        expect((await userByEmail(email))!.rdt_click_id).toBeNull();
    });

    /** Ad reporting is downstream of registration and must never gate it. */
    it('registers the user even though the integration is unconfigured in tests', async () => {
        const email = `works-${crypto.randomUUID()}@test.dev`;
        expect((await signup({ email, password: 'password123' })).status).toBe(200);

        const user = await userByEmail(email);
        const rows = await conversionsFor(user!.id as number);
        expect(rows[0]!.status).toBe('skipped');
        expect(rows[0]!.error).toBe('reddit_not_configured');
    });
});
