import { describe, it, expect } from 'vitest';
import {
    GOOGLE_ADS_ID,
    DOWNLOAD_CONVERSION_LABEL,
    isValidTagId,
    googleTagSrc,
    googleTagBootstrap,
    conversionSendTo,
} from './google-ads';

describe('GOOGLE_ADS_ID', () => {
    it('is the Google Ads conversion account the campaigns run under', () => {
        expect(GOOGLE_ADS_ID).toBe('AW-18462380797');
    });

    /** A typo in the constant must fail here rather than at `astro build`. */
    it('is a well-formed tag id', () => {
        expect(isValidTagId(GOOGLE_ADS_ID)).toBe(true);
    });
});

describe('isValidTagId', () => {
    it.each([
        ['a Google Ads conversion id', 'AW-18462380797'],
        ['a GA4 measurement id', 'G-ABC123XYZ'],
        ['a Google tag id', 'GT-ABC1234'],
        ['a Tag Manager container id', 'GTM-ABC1234'],
        ['a Campaign Manager id', 'DC-1234567'],
    ])('accepts %s', (_label, id) => {
        expect(isValidTagId(id)).toBe(true);
    });

    /**
     * The id is interpolated into a URL and into a single-quoted JS string
     * inside an inline <script>. Everything below either breaks out of one of
     * those two contexts or silently points the tag somewhere else, so the
     * filter is an allow-list rather than an escape pass.
     */
    it.each([
        ['empty', ''],
        ['no prefix', '18462380797'],
        ['an unknown prefix', 'XX-1234567'],
        ['a quote (JS string break-out)', "AW-1');alert(1);('"],
        ['a closing script tag', 'AW-1</script><script>alert(1)</script>'],
        ['an ampersand (extra query parameter)', 'AW-1&foo=bar'],
        ['a slash (different origin path)', 'AW-1/../evil'],
        ['whitespace', 'AW-1 2'],
        ['a newline', 'AW-1\n'],
        ['a non-string', 42 as unknown as string],
    ])('rejects %s', (_label, id) => {
        expect(isValidTagId(id as string)).toBe(false);
    });
});

describe('googleTagSrc', () => {
    it('loads gtag.js for the given tag id', () => {
        expect(googleTagSrc('AW-18462380797')).toBe(
            'https://www.googletagmanager.com/gtag/js?id=AW-18462380797'
        );
    });

    it('throws on a malformed id rather than emitting a crafted URL', () => {
        expect(() => googleTagSrc('AW-1&foo=bar')).toThrow(/tag id/i);
    });
});

describe('googleTagBootstrap', () => {
    const bootstrap = googleTagBootstrap('AW-18462380797');

    it('creates the dataLayer queue before anything pushes to it', () => {
        expect(bootstrap).toContain('window.dataLayer = window.dataLayer || []');
    });

    it('defines the gtag shim that gtag.js later drains', () => {
        expect(bootstrap).toContain('function gtag(){dataLayer.push(arguments);}');
    });

    it('stamps the load time and configures the tag id', () => {
        expect(bootstrap).toContain("gtag('js', new Date());");
        expect(bootstrap).toContain("gtag('config', 'AW-18462380797');");
    });

    /** It is emitted inline, so a '<' anywhere in it could end the element. */
    it('contains no markup that could close the script element', () => {
        expect(bootstrap).not.toContain('<');
    });

    it('throws on a malformed id rather than emitting injected script', () => {
        expect(() => googleTagBootstrap("AW-1');alert(1);('")).toThrow(/tag id/i);
    });
});

/**
 * The conversion the download click reports.
 *
 * It points at a Google Ads action NAMED "Purchase" on purpose: the campaign
 * was built optimizing for Purchase, and the owner chose to feed it downloads
 * rather than repoint the campaign. The name is Google's; the trigger is a
 * download.
 */
describe('DOWNLOAD_CONVERSION_LABEL', () => {
    it('is the label Google Ads issued for that action', () => {
        expect(DOWNLOAD_CONVERSION_LABEL).toBe('k8AWCJW33f0cEP2lxuNE');
    });

    /** Google labels are URL-safe tokens. A stray quote or slash here would
     *  address a different action, or none, and report nothing forever. */
    it('is a plain URL-safe token', () => {
        expect(DOWNLOAD_CONVERSION_LABEL).toMatch(/^[A-Za-z0-9_-]+$/);
    });
});

describe('conversionSendTo', () => {
    it('joins the account and the label the way gtag expects', () => {
        expect(conversionSendTo('k8AWCJW33f0cEP2lxuNE')).toBe(
            'AW-18462380797/k8AWCJW33f0cEP2lxuNE'
        );
    });

    it('defaults to the download conversion', () => {
        expect(conversionSendTo()).toBe(`${GOOGLE_ADS_ID}/${DOWNLOAD_CONVERSION_LABEL}`);
    });

    it.each([
        ['empty', ''],
        ['a slash (second path segment)', 'abc/def'],
        ['a quote', "abc'def"],
        ['whitespace', 'abc def'],
    ])('throws on a label containing %s', (_label, value) => {
        expect(() => conversionSendTo(value)).toThrow(/conversion label/i);
    });
});
