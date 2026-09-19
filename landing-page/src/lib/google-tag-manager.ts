/**
 * The Google Tag Manager container.
 *
 * GTM sits BESIDE the hardcoded Google tag in `google-ads.ts`, and the split
 * between them is deliberate:
 *
 *  - The Google Ads destination `AW-18462380797` is owned by the code. It is
 *    configured once, in `LandingLayout`, and cannot be switched off by
 *    publishing a bad container version.
 *  - Everything built ON TOP of that destination — conversion actions, their
 *    labels, click triggers, any other vendor — is owned by GTM, so it can
 *    change without a deploy. That is the whole reason the container exists.
 *
 * The one rule that keeps this from breaking: DO NOT add a "Google tag"
 * configuration tag for `AW-18462380797` inside the container. Both copies
 * would call `gtag('config', …)` for the same destination and the site would
 * report every page view to Google Ads twice. A "Google Ads Conversion
 * Tracking" tag in GTM is fine and is the intended path — it sends an event
 * against the gtag this page already loaded.
 *
 * Both share `window.dataLayer` on purpose: gtag's bootstrap creates it, GTM
 * attaches to the same array, and a `dataLayer.push` from our own code is
 * visible to both.
 */

import { isValidTagId } from './google-ads';

/**
 * The container id.
 *
 * Public by construction, like the Ads id and the Reddit pixel id: it ships
 * in the page's HTML the moment the container loads.
 */
export const GTM_CONTAINER_ID = 'GTM-WXW3FWBT';

/**
 * The custom event the download links push onto `dataLayer`.
 *
 * A CONTRACT with the container: a Custom Event trigger named for this is
 * what fires the Google Ads download conversion, so the conversion can be
 * created, relabelled or removed in GTM's UI with no deploy here. Renaming
 * this string silently stops that tag firing.
 *
 * Not `file_download`, which is GA4 enhanced measurement's own automatic
 * event — colliding with it would mix our push into a stream Google also
 * writes to.
 */
export const DOWNLOAD_EVENT = 'download';

/** Shared guard with `google-ads.ts` — the id lands in a URL query string and
 *  in a single-quoted JS string inside an inline `<script>`, and `isValidTagId`
 *  already allows the `GTM-` prefix. Throws rather than degrading: a typo here
 *  should fail `astro build`, not ship a container that loads nothing. */
function assertContainerId(id: string): string {
    if (!isValidTagId(id)) {
        throw new Error(`Refusing to emit an invalid Google tag id: ${JSON.stringify(id)}`);
    }
    return id;
}

/**
 * Google's container snippet, verbatim apart from the id.
 *
 * Kept as a built string rather than pasted into the layout so the marketing
 * pages and the docs injection in `astro.config.mjs` cannot drift, and so the
 * shape is testable without a DOM.
 */
export function gtmBootstrap(id: string = GTM_CONTAINER_ID): string {
    const containerId = assertContainerId(id);
    return `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','${containerId}');`;
}

/**
 * The `<noscript>` iframe's source.
 *
 * Worth almost nothing in practice — with JavaScript off, the container can
 * only fire image and iframe tags, so no Google Ads conversion will ever come
 * through it — but it is part of Google's documented install, and Tag
 * Assistant checks for it.
 */
export function gtmNoscriptSrc(id: string = GTM_CONTAINER_ID): string {
    return `https://www.googletagmanager.com/ns.html?id=${assertContainerId(id)}`;
}
