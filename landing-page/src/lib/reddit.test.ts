import { describe, it, expect } from 'vitest';
import {
    sanitizeClickId,
    clickIdFromSearch,
    readCookie,
    cookieDomain,
    clickIdCookieString,
    captureClickId,
    attributionFrom,
    attributionQuery,
    CLICK_ID_COOKIE,
    PIXEL_UUID_COOKIE,
} from './reddit';

describe('sanitizeClickId', () => {
    it('accepts a Reddit-shaped click id', () => {
        expect(sanitizeClickId('eyJhbGciOi-_.123')).toBe('eyJhbGciOi-_.123');
    });

    it('trims surrounding whitespace', () => {
        expect(sanitizeClickId('  abc123  ')).toBe('abc123');
    });

    it.each([
        ['empty', ''],
        ['whitespace only', '   '],
        ['null', null],
        ['undefined', undefined],
        ['non-string', 42 as unknown as string],
    ])('rejects %s', (_label, input) => {
        expect(sanitizeClickId(input as string)).toBeNull();
    });

    /**
     * The reason the filter is an allow-list. A value carrying `;` could close
     * the cookie value and append attributes or a second cookie, reachable by
     * anyone who can get a user to open a crafted URL.
     */
    it.each([
        ['semicolons (cookie injection)', 'abc; Domain=evil.test'],
        ['commas (cookie injection)', 'abc, evil=1'],
        ['equals', 'abc=def'],
        ['spaces', 'abc def'],
        ['newlines (header injection)', 'abc\r\nSet-Cookie: evil=1'],
        ['angle brackets', '<script>'],
    ])('rejects a click id containing %s', (_label, input) => {
        expect(sanitizeClickId(input)).toBeNull();
    });

    it('rejects an oversized click id rather than filling the cookie jar', () => {
        expect(sanitizeClickId('a'.repeat(513))).toBeNull();
        expect(sanitizeClickId('a'.repeat(512))).toBe('a'.repeat(512));
    });
});

describe('clickIdFromSearch', () => {
    it('reads rdt_cid from an ad landing URL', () => {
        expect(clickIdFromSearch('?rdt_cid=abc123')).toBe('abc123');
    });

    it('works with or without the leading question mark', () => {
        expect(clickIdFromSearch('rdt_cid=abc123')).toBe('abc123');
    });

    it('finds it among other parameters', () => {
        expect(clickIdFromSearch('?utm_source=reddit&rdt_cid=abc123&utm_medium=cpc')).toBe('abc123');
    });

    it('returns null when the parameter is absent', () => {
        expect(clickIdFromSearch('?utm_source=reddit')).toBeNull();
        expect(clickIdFromSearch('')).toBeNull();
    });

    it('returns null for a hostile value instead of storing it', () => {
        expect(clickIdFromSearch('?rdt_cid=' + encodeURIComponent('a; Domain=evil.test'))).toBeNull();
    });
});

describe('readCookie', () => {
    it('reads a value from a multi-cookie jar', () => {
        expect(readCookie('a=1; rdt_cid=abc; b=2', 'rdt_cid')).toBe('abc');
    });

    it('returns null for an absent cookie', () => {
        expect(readCookie('a=1; b=2', 'rdt_cid')).toBeNull();
    });

    it('does not match a cookie whose name merely ends with the target', () => {
        expect(readCookie('not_rdt_cid=nope', 'rdt_cid')).toBeNull();
    });

    it('decodes a percent-encoded value', () => {
        expect(readCookie('rdt_cid=a%2Eb', 'rdt_cid')).toBe('a.b');
    });

    it('survives a malformed percent-sequence rather than throwing on every page load', () => {
        expect(readCookie('rdt_cid=100%', 'rdt_cid')).toBe('100%');
    });

    it('treats an empty value as absent', () => {
        expect(readCookie('rdt_cid=', 'rdt_cid')).toBeNull();
    });
});

describe('cookieDomain', () => {
    it.each(['unityide.app', 'www.unityide.app', 'dev.unityide.app'])(
        'scopes %s to the apex so the ad landing page and /auth share one cookie',
        (hostname) => {
            expect(cookieDomain(hostname)).toBe('.unityide.app');
        },
    );

    it.each(['localhost', '127.0.0.1', 'some-preview.pages.dev'])(
        'leaves %s host-only, since an invalid Domain would drop the cookie entirely',
        (hostname) => {
            expect(cookieDomain(hostname)).toBeNull();
        },
    );

    it('does not treat a lookalike domain as ours', () => {
        expect(cookieDomain('notunityide.app')).toBeNull();
        expect(cookieDomain('unityide.app.evil.test')).toBeNull();
    });
});

describe('clickIdCookieString', () => {
    it('sets the apex domain, a 30-day life, Lax and Secure in production', () => {
        const cookie = clickIdCookieString('abc123', 'unityide.app');
        expect(cookie).toContain('rdt_cid=abc123');
        expect(cookie).toContain('Domain=.unityide.app');
        expect(cookie).toContain('Max-Age=2592000');
        expect(cookie).toContain('SameSite=Lax');
        expect(cookie).toContain('Secure');
    });

    /** Strict would withhold the cookie on the cross-site navigation FROM
     *  reddit.com, which is the only page load that ever carries a click id. */
    it('never uses SameSite=Strict', () => {
        expect(clickIdCookieString('abc123', 'unityide.app')).not.toContain('Strict');
    });

    it('omits Secure and Domain on localhost so dev actually stores it', () => {
        const cookie = clickIdCookieString('abc123', 'localhost');
        expect(cookie).not.toContain('Secure');
        expect(cookie).not.toContain('Domain=');
    });
});

describe('captureClickId', () => {
    it('stores the click id when the ad lands', () => {
        const doc = { cookie: '' };
        const stored = captureClickId({ search: '?rdt_cid=abc123', hostname: 'unityide.app' }, doc);
        expect(stored).toBe('abc123');
        expect(doc.cookie).toContain('rdt_cid=abc123');
    });

    /** Most page loads in a session are not the landing page; clearing on
     *  those would discard the attribution seconds after winning it. */
    it('leaves an existing cookie alone on a page load with no rdt_cid', () => {
        const doc = { cookie: 'rdt_cid=earlier' };
        const stored = captureClickId({ search: '?utm_source=reddit', hostname: 'unityide.app' }, doc);
        expect(stored).toBeNull();
        expect(doc.cookie).toBe('rdt_cid=earlier');
    });

    it('overwrites on a newer click, because Reddit credits the last one', () => {
        const doc = { cookie: 'rdt_cid=older' };
        captureClickId({ search: '?rdt_cid=newer', hostname: 'unityide.app' }, doc);
        expect(doc.cookie).toContain('rdt_cid=newer');
    });

    it('does not store a hostile click id', () => {
        const doc = { cookie: '' };
        const stored = captureClickId(
            { search: '?rdt_cid=' + encodeURIComponent('a; Domain=evil.test'), hostname: 'unityide.app' },
            doc,
        );
        expect(stored).toBeNull();
        expect(doc.cookie).toBe('');
    });
});

describe('attributionFrom', () => {
    it('returns both identifiers when the pixel has run and an ad was clicked', () => {
        const jar = `${CLICK_ID_COOKIE}=abc123; ${PIXEL_UUID_COOKIE}=uuid-value`;
        expect(attributionFrom({ cookie: jar })).toEqual({ rdtCid: 'abc123', rdtUuid: 'uuid-value' });
    });

    /** The pixel never runs on /auth, so a direct signup legitimately has a
     *  click id and no uuid. Omitted, not null — the server's check is a
     *  presence test. */
    it('omits absent fields entirely', () => {
        expect(attributionFrom({ cookie: `${CLICK_ID_COOKIE}=abc123` })).toEqual({ rdtCid: 'abc123' });
        expect(attributionFrom({ cookie: '' })).toEqual({});
    });
});

describe('attributionQuery', () => {
    it('produces an appendable fragment for the OAuth start redirect', () => {
        const jar = `${CLICK_ID_COOKIE}=abc123; ${PIXEL_UUID_COOKIE}=uuid-value`;
        expect(attributionQuery({ cookie: jar })).toBe('&rdt_cid=abc123&rdt_uuid=uuid-value');
    });

    it('is empty when there is nothing to attribute, leaving the URL untouched', () => {
        expect(attributionQuery({ cookie: '' })).toBe('');
    });
});
