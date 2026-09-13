/**
 * Reddit ad attribution, kept deliberately first-party.
 *
 * Reddit's pixel is a THIRD-PARTY script, and `LandingLayout`'s `analytics`
 * prop keeps every such script off /auth, /verify, /reset, /account and
 * /admin — those URLs carry one-time tokens and codes, and a third-party
 * autocapture script would read them out of the URL before React scrubs it.
 *
 * But /auth is precisely where the click id matters: account creation is the
 * only moment we can bind a Reddit ad click to a person, and it is the event
 * the server later reports through the Conversions API. So the click id is
 * handled here as FIRST-PARTY state instead — read off the ad's `rdt_cid`
 * query parameter on whatever marketing page the ad landed on, parked in a
 * first-party cookie, and read back on the auth page with no third-party
 * script involved. The invariant survives and the attribution still works.
 */

/**
 * The advertiser's pixel id.
 *
 * Safe to hardcode: it ships in the page's HTML by construction, so it is
 * public the moment the pixel loads. It doubles as the Reddit *ad account* id
 * in the Conversions API URL the Worker posts to — same string, two roles —
 * which is why the server keeps its own copy in `wrangler.toml` rather than
 * importing across package boundaries.
 */
export const REDDIT_PIXEL_ID = 'a2_joe9q5eoimhu';

/** Reddit appends this to the landing URL of every ad click. */
export const CLICK_ID_PARAM = 'rdt_cid';

/** Our own cookie. Named for what it holds; not read by Reddit's pixel. */
export const CLICK_ID_COOKIE = 'rdt_cid';

/** The pixel's OWN cookie, set by redditstatic's script on marketing pages.
 *  Forwarded to the Conversions API as `user.uuid`, which lets Reddit stitch
 *  a server-side event to the same browser the pixel already saw. */
export const PIXEL_UUID_COOKIE = '_rdt_uuid';

/** Reddit's click-through attribution window is 28 days. 30 gives a little
 *  slack for a user who installs on the last day without keeping a click
 *  alive longer than Reddit would ever credit it. */
export const CLICK_ID_MAX_AGE_DAYS = 30;

/**
 * Upper bound on a stored click id.
 *
 * This value arrives in a URL that anyone can craft, gets written into a
 * cookie, and is later sent to our API and on to Reddit. Three reasons to
 * bound it, and to bound it tightly: a cookie jar is a shared, limited
 * resource (an oversized value can evict real cookies), an unbounded string
 * would ride into a D1 column and a third-party request body, and — because
 * the cookie is scoped to `.unityide.app` so the apex and www agree — every
 * byte also rides on every request to api.unityide.app and
 * releases.unityide.app for the next 30 days. Real Reddit click ids are far
 * shorter than this; 128 is already generous.
 */
const CLICK_ID_MAX_LENGTH = 128;

/**
 * Characters a click id may contain.
 *
 * Deliberately strict rather than "escape the dangerous ones". `;` and `,` are
 * cookie *syntax* — a value containing either can terminate the value and
 * inject a second cookie (`Path`, `Domain`, or an entirely different name),
 * so a permissive filter here would be a cookie-injection primitive reachable
 * from a query parameter. Reddit's click ids are URL-safe base64-ish tokens,
 * so this rejects nothing real.
 */
const SAFE_TOKEN = /^[A-Za-z0-9._~-]+$/;

/** A click id we are willing to store and forward, or null. */
export function sanitizeClickId(raw: string | null | undefined): string | null {
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    if (value === '' || value.length > CLICK_ID_MAX_LENGTH) return null;
    return SAFE_TOKEN.test(value) ? value : null;
}

/** The `rdt_cid` carried by an ad landing URL, or null. */
export function clickIdFromSearch(search: string): string | null {
    // `URLSearchParams` tolerates a leading '?' or its absence.
    const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
    return sanitizeClickId(params.get(CLICK_ID_PARAM));
}

/** One cookie's value out of a `document.cookie` string, or null. */
export function readCookie(jar: string, name: string): string | null {
    for (const part of jar.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        if (part.slice(0, eq).trim() !== name) continue;
        const value = part.slice(eq + 1).trim();
        try {
            return value === '' ? null : decodeURIComponent(value);
        } catch {
            // A malformed %-sequence must not throw on every page load.
            return value === '' ? null : value;
        }
    }
    return null;
}

/**
 * Whether a cookie for this hostname should be scoped to the apex domain.
 *
 * Needed because the ad can land on `unityide.app` or `www.unityide.app` while
 * the auth page that reads the cookie back may be on the other — a host-only
 * cookie would silently not be there. Localhost and preview hosts get a
 * host-only cookie: `Domain=localhost` is invalid and would be dropped.
 */
export function cookieDomain(hostname: string): string | null {
    return hostname === 'unityide.app' || hostname.endsWith('.unityide.app')
        ? '.unityide.app'
        : null;
}

/** A `document.cookie` assignment string for the click id. */
export function clickIdCookieString(
    value: string,
    hostname: string,
    maxAgeDays: number = CLICK_ID_MAX_AGE_DAYS,
): string {
    const domain = cookieDomain(hostname);
    return [
        `${CLICK_ID_COOKIE}=${encodeURIComponent(value)}`,
        'Path=/',
        `Max-Age=${Math.round(maxAgeDays * 86_400)}`,
        // Lax, not Strict: the user arrives here by a cross-site navigation
        // from reddit.com, and Strict would withhold the cookie on exactly
        // that first request. Lax still blocks cross-site subrequests.
        'SameSite=Lax',
        ...(domain ? [`Domain=${domain}`] : []),
        // Secure is skipped on localhost, where there is no https to carry it.
        ...(hostname === 'localhost' || hostname === '127.0.0.1' ? [] : ['Secure']),
    ].join('; ');
}

/**
 * Persist the click id from the current URL, if this page load is an ad click.
 *
 * Last-click wins: a fresh `rdt_cid` overwrites a stored one, because the most
 * recent ad is the one Reddit will credit. A page load WITHOUT the parameter
 * leaves an existing cookie alone — most pages in a session are not the
 * landing page, and clearing on those would throw away the attribution.
 */
export function captureClickId(loc: { search: string; hostname: string }, doc: { cookie: string }): string | null {
    const clickId = clickIdFromSearch(loc.search);
    if (!clickId) return null;
    doc.cookie = clickIdCookieString(clickId, loc.hostname);
    return clickId;
}

export interface RedditAttribution {
    rdtCid?: string;
    rdtUuid?: string;
}

/**
 * What the browser knows about this visitor's Reddit provenance, shaped for
 * the API. Absent fields are omitted rather than sent as null so the server's
 * "did we learn anything new" check stays a simple presence test.
 */
export function attributionFrom(doc: { cookie: string }): RedditAttribution {
    const out: RedditAttribution = {};
    const clickId = sanitizeClickId(readCookie(doc.cookie, CLICK_ID_COOKIE));
    if (clickId) out.rdtCid = clickId;
    // The pixel's uuid is written by Reddit's own script, so it is trusted to
    // the same degree as the pixel itself — but it still rides into a cookie
    // and an API body, so it gets the same bound as the click id.
    const uuid = sanitizeClickId(readCookie(doc.cookie, PIXEL_UUID_COOKIE));
    if (uuid) out.rdtUuid = uuid;
    return out;
}

/**
 * The live cookie jar, or an empty one when there is no browser.
 *
 * `googleStartUrl` / `githubStartUrl` are plain string builders, and Astro
 * evaluates them during `astro build` as well as in the browser. Reaching for
 * a bare `document` there is a build-time ReferenceError, so every ambient
 * read goes through this. Outside a browser there is no attribution to find,
 * and an empty jar is the honest answer rather than a crash.
 */
function ambientJar(): { cookie: string } {
    return typeof document === 'undefined' ? { cookie: '' } : document;
}

/** `attributionFrom` against the live document; safe during SSR and in tests. */
export function currentAttribution(): RedditAttribution {
    return attributionFrom(ambientJar());
}

/** `attributionQuery` against the live document; safe during SSR and in tests. */
export function currentAttributionQuery(): string {
    return attributionQuery(ambientJar());
}

/** Query string appending whatever attribution we hold, for the OAuth start
 *  redirects — those leave the site, so a request body is not available. */
export function attributionQuery(doc: { cookie: string }): string {
    const attribution = attributionFrom(doc);
    const params = new URLSearchParams();
    if (attribution.rdtCid) params.set('rdt_cid', attribution.rdtCid);
    if (attribution.rdtUuid) params.set('rdt_uuid', attribution.rdtUuid);
    const query = params.toString();
    return query === '' ? '' : `&${query}`;
}
