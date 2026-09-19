import { describe, it, expect } from 'vitest';
import { isValidTagId } from './google-ads';
import {
    GTM_CONTAINER_ID,
    DOWNLOAD_EVENT,
    gtmBootstrap,
    gtmNoscriptSrc,
} from './google-tag-manager';

describe('GTM_CONTAINER_ID', () => {
    it('is the container created for this site', () => {
        expect(GTM_CONTAINER_ID).toBe('GTM-WXW3FWBT');
    });

    /** A typo in the constant must fail here rather than at `astro build`. */
    it('is a well-formed tag id', () => {
        expect(isValidTagId(GTM_CONTAINER_ID)).toBe(true);
    });
});

describe('gtmBootstrap', () => {
    const bootstrap = gtmBootstrap('GTM-WXW3FWBT');

    it('seeds the queue before pushing to it', () => {
        expect(bootstrap).toContain("w[l]=w[l]||[]");
    });

    it('stamps gtm.start, which the container reads as its load time', () => {
        expect(bootstrap).toContain("{'gtm.start':");
        expect(bootstrap).toContain("event:'gtm.js'");
    });

    it('loads the container script asynchronously', () => {
        expect(bootstrap).toContain("j.async=true");
        expect(bootstrap).toContain("'https://www.googletagmanager.com/gtm.js?id='+i+dl");
    });

    it('passes the container id as the snippet argument', () => {
        expect(bootstrap).toContain("'script','dataLayer','GTM-WXW3FWBT'");
    });

    /**
     * The queue name is load-bearing. gtag's bootstrap already created
     * `window.dataLayer`; GTM must attach to that SAME array or the two
     * tagging systems keep separate queues on one page.
     */
    it('uses the default dataLayer name, the one gtag already created', () => {
        expect(bootstrap).toContain("'dataLayer'");
        expect(bootstrap).not.toContain('customDataLayer');
    });

    /** It is emitted inline, so a '<' anywhere in it could end the element. */
    it('contains no markup that could close the script element', () => {
        expect(bootstrap).not.toContain('<');
    });

    it.each([
        ['a quote (JS string break-out)', "GTM-1');alert(1);('"],
        ['a closing script tag', 'GTM-1</script>'],
        ['an unknown prefix', 'XX-WXW3FWBT'],
        ['empty', ''],
    ])('throws on %s rather than emitting injected script', (_label, id) => {
        expect(() => gtmBootstrap(id)).toThrow(/tag id/i);
    });
});

describe('gtmNoscriptSrc', () => {
    it('builds the iframe fallback URL for the container', () => {
        expect(gtmNoscriptSrc('GTM-WXW3FWBT')).toBe(
            'https://www.googletagmanager.com/ns.html?id=GTM-WXW3FWBT'
        );
    });

    it('throws on a malformed id rather than emitting a crafted URL', () => {
        expect(() => gtmNoscriptSrc('GTM-1&foo=bar')).toThrow(/tag id/i);
    });
});

/**
 * This string is a CONTRACT with the GTM container, not an implementation
 * detail: a Custom Event trigger named for it is what fires the download
 * conversion. Renaming it here silently stops that tag firing, with nothing
 * in this repo to catch it — hence the test.
 */
describe('DOWNLOAD_EVENT', () => {
    it('is the custom event name the container triggers on', () => {
        expect(DOWNLOAD_EVENT).toBe('download');
    });

    it('avoids GA4 enhanced measurement\'s own file_download name', () => {
        expect(DOWNLOAD_EVENT).not.toBe('file_download');
    });
});
