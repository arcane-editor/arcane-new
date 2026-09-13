import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
    sha256Hex,
    looksHashed,
    normalizeEmail,
    eventTypeFor,
    buildEvent,
    hasIdentity,
    redditConfig,
    conversionsUrl,
    postEvent,
    reportConversion,
    type RedditConfig,
    type RedditEventPayload,
} from '../src/lib/reddit.ts';

const CONFIG: RedditConfig = { token: 'tok', accountId: 'a2_test', testMode: false };

/** A fetch stub that records what it was called with and replays a script of
 *  responses, so retry behaviour is observable without a network. */
function stubFetch(responses: Array<{ status: number; body?: string } | Error>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let i = 0;
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        const next = responses[Math.min(i++, responses.length - 1)]!;
        if (next instanceof Error) throw next;
        return new Response(next.body ?? '', { status: next.status });
    }) as unknown as typeof fetch;
    return { impl, calls };
}

function redditEnv(overrides: Record<string, unknown> = {}) {
    return {
        arcane_db: env.arcane_db,
        REDDIT_CONVERSION_TOKEN: 'tok',
        REDDIT_AD_ACCOUNT_ID: 'a2_test',
        ENVIRONMENT: 'production',
        ...overrides,
    } as Parameters<typeof reportConversion>[0];
}

async function auditRowFor(conversionId: string) {
    return env.arcane_db
        .prepare('SELECT * FROM reddit_conversions WHERE conversion_id = ?')
        .bind(conversionId)
        .first<Record<string, unknown>>();
}

describe('sha256Hex', () => {
    it('produces the standard lowercase hex digest', async () => {
        // Known vector — guards against an encoding or padding regression.
        expect(await sha256Hex('abc')).toBe(
            'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        );
    });

    it('pads bytes below 0x10 to two digits', async () => {
        expect(await sha256Hex('test')).toHaveLength(64);
    });
});

describe('normalizeEmail', () => {
    it('lowercases and trims', () => {
        expect(normalizeEmail('  Dev@Example.COM ')).toBe('dev@example.com');
    });

    /**
     * The deliberate non-behaviour. Reddit's own pixel hashes the lowercased,
     * trimmed address; stripping dots or `+tags` here would produce a digest
     * that disagrees with the pixel's for the same person and silently halve
     * match quality.
     */
    it('does NOT apply gmail-style canonicalization', () => {
        expect(normalizeEmail('first.last+ads@gmail.com')).toBe('first.last+ads@gmail.com');
    });
});

describe('looksHashed', () => {
    it('recognizes a digest so a pre-hashed value is not hashed twice', () => {
        expect(looksHashed('a'.repeat(64))).toBe(true);
        expect(looksHashed('A'.repeat(64))).toBe(true);
    });

    it('rejects anything that is not 64 hex characters', () => {
        expect(looksHashed('dev@example.com')).toBe(false);
        expect(looksHashed('a'.repeat(63))).toBe(false);
        expect(looksHashed('z'.repeat(64))).toBe(false);
    });
});

describe('eventTypeFor', () => {
    it('maps SignUp and Purchase to standard tracking types', () => {
        expect(eventTypeFor('SignUp')).toEqual({ tracking_type: 'SignUp' });
        expect(eventTypeFor('Purchase')).toEqual({ tracking_type: 'Purchase' });
    });

    /** Reddit has no native app-install event for a web pixel account, so the
     *  install has to be a named custom event. */
    it('maps Install to a named custom event', () => {
        expect(eventTypeFor('Install')).toEqual({
            tracking_type: 'Custom',
            custom_event_name: 'Install',
        });
    });
});

describe('buildEvent', () => {
    it('hashes the email with the normalized form', async () => {
        const event = await buildEvent({ eventName: 'SignUp', email: ' Dev@Example.COM ' }, 'cid-1');
        expect(event.user!.email).toBe(await sha256Hex('dev@example.com'));
    });

    it('hashes external_id and ip_address', async () => {
        const event = await buildEvent(
            { eventName: 'SignUp', externalId: '42', ipAddress: '203.0.113.7' },
            'cid-2',
        );
        expect(event.user!.external_id).toBe(await sha256Hex('42'));
        expect(event.user!.ip_address).toBe(await sha256Hex('203.0.113.7'));
    });

    it('passes the user agent and pixel uuid through unhashed, as Reddit expects', async () => {
        const event = await buildEvent(
            { eventName: 'SignUp', userAgent: 'Mozilla/5.0', rdtUuid: 'uuid-1' },
            'cid-3',
        );
        expect(event.user!.user_agent).toBe('Mozilla/5.0');
        expect(event.user!.uuid).toBe('uuid-1');
    });

    /** The single most consequential shape detail: a click_id nested inside
     *  `user` is accepted with a 200 and attributed to nobody. */
    it('places click_id at the event root, not inside user', async () => {
        const event = await buildEvent({ eventName: 'SignUp', clickId: 'click-1' }, 'cid-4');
        expect(event.click_id).toBe('click-1');
        expect((event.user as Record<string, unknown> | undefined)?.click_id).toBeUndefined();
    });

    it('echoes the conversion id so a retry collapses instead of double-counting', async () => {
        const event = await buildEvent({ eventName: 'SignUp' }, 'cid-5');
        expect(event.event_metadata!.conversion_id).toBe('cid-5');
    });

    it('omits empty match keys rather than sending them blank', async () => {
        const event = await buildEvent(
            { eventName: 'SignUp', email: '  ', clickId: '', externalId: null },
            'cid-6',
        );
        expect(event.user).toBeUndefined();
        expect(event.click_id).toBeUndefined();
    });

    it('does not re-hash a value that is already a digest', async () => {
        const digest = await sha256Hex('dev@example.com');
        const event = await buildEvent({ eventName: 'SignUp', email: digest }, 'cid-7');
        expect(event.user!.email).toBe(digest);
    });

    it('attaches value and currency only for a purchase', async () => {
        const purchase = await buildEvent({ eventName: 'Purchase', valueDecimal: 25 }, 'cid-8');
        expect(purchase.event_metadata).toMatchObject({ value_decimal: 25, currency: 'USD', item_count: 1 });

        const signup = await buildEvent({ eventName: 'SignUp' }, 'cid-9');
        expect(signup.event_metadata!.value_decimal).toBeUndefined();
    });

    it('emits an ISO-8601 event_at', async () => {
        const at = new Date('2026-09-13T10:00:00.000Z');
        const event = await buildEvent({ eventName: 'SignUp', eventAt: at }, 'cid-10');
        expect(event.event_at).toBe('2026-09-13T10:00:00.000Z');
    });
});

describe('hasIdentity', () => {
    const base: RedditEventPayload = {
        event_at: '2026-09-13T10:00:00.000Z',
        event_type: { tracking_type: 'SignUp' },
    };

    it('accepts an event carrying a click id', () => {
        expect(hasIdentity({ ...base, click_id: 'c' })).toBe(true);
    });

    it('accepts an event carrying any match key', () => {
        expect(hasIdentity({ ...base, user: { email: 'h' } })).toBe(true);
    });

    /** Reddit 200s on these and attributes them to nobody, which would make
     *  the audit table read as success while the campaign reports nothing. */
    it('rejects an event with neither', () => {
        expect(hasIdentity(base)).toBe(false);
        expect(hasIdentity({ ...base, user: {} })).toBe(false);
    });
});

describe('redditConfig', () => {
    it('is null when the token is unset, which is how an unconfigured worker behaves', () => {
        expect(redditConfig({ REDDIT_AD_ACCOUNT_ID: 'a2_x', ENVIRONMENT: 'production' })).toBeNull();
    });

    it('is null when the account id is unset', () => {
        expect(redditConfig({ REDDIT_CONVERSION_TOKEN: 't', ENVIRONMENT: 'production' })).toBeNull();
    });

    it('treats a blank secret as unset rather than sending an empty bearer', () => {
        expect(redditConfig({
            REDDIT_CONVERSION_TOKEN: '   ', REDDIT_AD_ACCOUNT_ID: 'a2_x', ENVIRONMENT: 'production',
        })).toBeNull();
    });

    it('reports for real only on the production worker', () => {
        const prod = redditConfig({
            REDDIT_CONVERSION_TOKEN: 't', REDDIT_AD_ACCOUNT_ID: 'a2_x', ENVIRONMENT: 'production',
        });
        expect(prod!.testMode).toBe(false);
    });

    /** Dev shares one pixel id with live ad spend; test_mode is what makes
     *  that safe. */
    it('forces test mode everywhere else', () => {
        for (const environment of ['development', 'staging', undefined]) {
            const cfg = redditConfig({
                REDDIT_CONVERSION_TOKEN: 't', REDDIT_AD_ACCOUNT_ID: 'a2_x', ENVIRONMENT: environment,
            });
            expect(cfg!.testMode).toBe(true);
        }
    });
});

describe('conversionsUrl', () => {
    it('targets the v2.0 conversions endpoint for the ad account', () => {
        expect(conversionsUrl('a2_joe9q5eoimhu'))
            .toBe('https://ads-api.reddit.com/api/v2.0/conversions/events/a2_joe9q5eoimhu');
    });
});

describe('postEvent', () => {
    const event: RedditEventPayload = {
        event_at: '2026-09-13T10:00:00.000Z',
        event_type: { tracking_type: 'SignUp' },
        click_id: 'c',
    };

    it('sends a bearer token and the event wrapped in an events array', async () => {
        const { impl, calls } = stubFetch([{ status: 200 }]);
        const out = await postEvent(CONFIG, event, impl);

        expect(out.ok).toBe(true);
        expect(calls[0]!.url).toBe('https://ads-api.reddit.com/api/v2.0/conversions/events/a2_test');
        const headers = calls[0]!.init.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer tok');
        expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
            test_mode: false,
            events: [event],
        });
    });

    it('sends test_mode when configured, so dev never counts a conversion', async () => {
        const { impl, calls } = stubFetch([{ status: 200 }]);
        await postEvent({ ...CONFIG, testMode: true }, event, impl);
        expect(JSON.parse(calls[0]!.init.body as string).test_mode).toBe(true);
    });

    it('retries once on a 5xx and succeeds', async () => {
        const { impl, calls } = stubFetch([{ status: 503 }, { status: 200 }]);
        const out = await postEvent(CONFIG, event, impl);
        expect(out.ok).toBe(true);
        expect(calls).toHaveLength(2);
    });

    it('retries on a 429', async () => {
        const { impl, calls } = stubFetch([{ status: 429 }, { status: 200 }]);
        expect((await postEvent(CONFIG, event, impl)).ok).toBe(true);
        expect(calls).toHaveLength(2);
    });

    /** A 4xx is our bug; retrying just re-sends the same bad payload. */
    it('does not retry a 400 and reports the body', async () => {
        const { impl, calls } = stubFetch([{ status: 400, body: 'bad click_id' }]);
        const out = await postEvent(CONFIG, event, impl);
        expect(out.ok).toBe(false);
        expect(out.httpStatus).toBe(400);
        expect(out.error).toContain('bad click_id');
        expect(calls).toHaveLength(1);
    });

    it('retries a network failure and surfaces the message when both attempts fail', async () => {
        const { impl, calls } = stubFetch([new Error('connection reset')]);
        const out = await postEvent(CONFIG, event, impl);
        expect(out.ok).toBe(false);
        expect(out.error).toContain('connection reset');
        expect(calls).toHaveLength(2);
    });

    it('truncates a long error body so an HTML error page cannot fill a column', async () => {
        const { impl } = stubFetch([{ status: 500, body: 'x'.repeat(5000) }]);
        const out = await postEvent(CONFIG, event, impl);
        expect(out.error!.length).toBeLessThanOrEqual(500);
    });
});

describe('reportConversion', () => {
    it('records an ok row on success', async () => {
        const { impl } = stubFetch([{ status: 200 }]);
        const result = await reportConversion(
            redditEnv(), { eventName: 'SignUp', email: 'a@test.dev', userId: 1 }, impl,
        );

        expect(result.status).toBe('ok');
        const row = await auditRowFor(result.conversionId);
        expect(row!.status).toBe('ok');
        expect(row!.event_name).toBe('SignUp');
        expect(row!.http_status).toBe(200);
        expect(row!.user_id).toBe(1);
    });

    it('records a failed row with the status and error, rather than losing it to a log', async () => {
        const { impl } = stubFetch([{ status: 400, body: 'nope' }]);
        const result = await reportConversion(
            redditEnv(), { eventName: 'SignUp', email: 'b@test.dev' }, impl,
        );

        expect(result.status).toBe('failed');
        const row = await auditRowFor(result.conversionId);
        expect(row!.status).toBe('failed');
        expect(row!.http_status).toBe(400);
        expect(row!.error).toContain('nope');
    });

    /** An unconfigured production worker must be visible, not merely quiet. */
    it('records a skipped row when the integration is not configured, and sends nothing', async () => {
        const { impl, calls } = stubFetch([{ status: 200 }]);
        const result = await reportConversion(
            redditEnv({ REDDIT_CONVERSION_TOKEN: undefined }),
            { eventName: 'SignUp', email: 'c@test.dev' },
            impl,
        );

        expect(result.status).toBe('skipped');
        expect(calls).toHaveLength(0);
        expect((await auditRowFor(result.conversionId))!.error).toBe('reddit_not_configured');
    });

    it('skips an event Reddit could not attribute to anyone', async () => {
        const { impl, calls } = stubFetch([{ status: 200 }]);
        const result = await reportConversion(redditEnv(), { eventName: 'Install' }, impl);

        expect(result.status).toBe('skipped');
        expect(calls).toHaveLength(0);
        expect((await auditRowFor(result.conversionId))!.error).toBe('no_match_keys');
    });

    it('stores the click id unhashed so a mis-attribution stays debuggable', async () => {
        const { impl } = stubFetch([{ status: 200 }]);
        const result = await reportConversion(
            redditEnv(), { eventName: 'SignUp', clickId: 'click-abc', userId: 7 }, impl,
        );
        expect((await auditRowFor(result.conversionId))!.click_id).toBe('click-abc');
    });

    it('flags rows written in test mode', async () => {
        const { impl } = stubFetch([{ status: 200 }]);
        const result = await reportConversion(
            redditEnv({ ENVIRONMENT: 'development' }),
            { eventName: 'SignUp', email: 'd@test.dev' },
            impl,
        );
        expect((await auditRowFor(result.conversionId))!.test_mode).toBe(1);
    });

    /** It runs inside waitUntil, where a rejection is invisible and useless. */
    it('never rejects, even when the transport throws outright', async () => {
        const impl = (() => { throw new Error('boom'); }) as unknown as typeof fetch;
        const result = await reportConversion(redditEnv(), { eventName: 'SignUp', email: 'e@test.dev' }, impl);
        expect(result.status).toBe('failed');
    });
});
