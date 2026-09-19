/**
 * The Google tag (gtag.js), for the Google Ads account the campaigns bill to.
 *
 * This is the "Google tag", not a Google Tag Manager container: the snippet
 * loads `gtag/js` directly and configures one destination id. There is no GTM
 * container in front of it, so a tag added in the Google Ads UI reaches this
 * site without a deploy, but a *third-party* tag added to a GTM workspace
 * would not — that would need a `GTM-` container id installed here instead.
 *
 * Emitted by `LandingLayout` (marketing pages) and by Starlight's `head`
 * (docs), under the same two gates the Reddit pixel uses — see the comment on
 * `adTags` in `layouts/LandingLayout.astro` for why production only.
 */

/**
 * The advertiser's Google Ads conversion id.
 *
 * Safe to hardcode for the same reason the Reddit pixel id is: it ships in the
 * page's HTML by construction, so it is public the moment the tag loads.
 */
export const GOOGLE_ADS_ID = 'AW-18462380797';

/**
 * Tag ids Google issues, by product: Ads (`AW`), GA4 (`G`), Google tag (`GT`),
 * Tag Manager (`GTM`), Campaign Manager (`DC`) and Merchant Center (`MC`).
 */
const TAG_ID = /^(AW|G|GT|GTM|DC|MC)-[A-Za-z0-9]+$/;

/**
 * Whether a string is a tag id we are willing to put in a page.
 *
 * An allow-list rather than an escape pass, because the id lands in two
 * injection contexts at once: a URL's query string, and a single-quoted JS
 * string literal inside an inline `<script>`. A value carrying `'`, `<` or
 * `&` breaks out of one of them. Nothing here rejects a real Google id.
 */
export function isValidTagId(id: string): boolean {
    return typeof id === 'string' && TAG_ID.test(id);
}

/** Guard for the two emitters below. Throws rather than degrading: a bad id
 *  is a typo in a constant, and failing `astro build` is strictly better than
 *  shipping a silently dead tag that nobody notices for a month. */
function assertTagId(id: string): string {
    if (!isValidTagId(id)) {
        throw new Error(`Refusing to emit an invalid Google tag id: ${JSON.stringify(id)}`);
    }
    return id;
}

/** The async loader URL for gtag.js. */
export function googleTagSrc(id: string = GOOGLE_ADS_ID): string {
    return `https://www.googletagmanager.com/gtag/js?id=${assertTagId(id)}`;
}

/**
 * The inline bootstrap that must run alongside the loader.
 *
 * Google's snippet verbatim apart from the id being interpolated. Kept as a
 * string rather than written twice inline so the marketing pages and the docs
 * cannot drift apart, and so the shape is testable without a DOM.
 */
export function googleTagBootstrap(id: string = GOOGLE_ADS_ID): string {
    const tagId = assertTagId(id);
    return [
        'window.dataLayer = window.dataLayer || [];',
        'function gtag(){dataLayer.push(arguments);}',
        "gtag('js', new Date());",
        `gtag('config', '${tagId}');`,
    ].join('\n');
}
