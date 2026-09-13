/**
 * How Reddit ad attribution enters the server and gets bound to an account.
 *
 * Separate from `reddit.ts` on purpose: that module knows how to talk to
 * Reddit, this one knows where a click id comes from and what it means. The
 * two signup shapes need the same treatment from opposite directions — a
 * password signup carries it in a JSON body, an OAuth signup carries it
 * through a redirect's query string because there is no body to use.
 *
 * Everything here re-validates. The website sanitizes before storing the
 * cookie, but `/v1/auth/signup` is a public endpoint: the browser's check is a
 * convenience, and this is the one that counts.
 */

import { setUserRedditAttribution, findUserById } from './db.ts';
import { reportConversion } from './reddit.ts';
import type { UserRow } from './db.ts';

/**
 * Characters an attribution token may contain.
 *
 * Same allow-list the website applies. These values reach a D1 column and the
 * body of a request to a third party, so the bound is on the value's shape
 * once, here, rather than on escaping it correctly at each of those sites.
 */
const SAFE_TOKEN = /^[A-Za-z0-9._~-]{1,512}$/;

export interface RedditAttribution {
    clickId: string | null;
    rdtUuid: string | null;
}

export const NO_ATTRIBUTION: RedditAttribution = { clickId: null, rdtUuid: null };

/** A token we are willing to store and forward, or null. */
export function sanitizeToken(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    return SAFE_TOKEN.test(value) ? value : null;
}

/** Attribution from a JSON request body (password signup). */
export function redditAttributionFrom(body: Record<string, unknown>): RedditAttribution {
    return {
        clickId: sanitizeToken(body.rdtCid),
        rdtUuid: sanitizeToken(body.rdtUuid),
    };
}

/** Attribution from a URL's query string (OAuth start, which has no body). */
export function redditAttributionFromQuery(url: string): RedditAttribution {
    const params = new URL(url).searchParams;
    return {
        clickId: sanitizeToken(params.get('rdt_cid')),
        rdtUuid: sanitizeToken(params.get('rdt_uuid')),
    };
}

/** True when there is anything worth carrying through a flow. */
export function hasAttribution(attribution: RedditAttribution): boolean {
    return Boolean(attribution.clickId || attribution.rdtUuid);
}

/**
 * Persist an account's provenance and report the SignUp conversion.
 *
 * Called from every path that creates a user — password, Google, GitHub — so
 * the conversion fires once per account regardless of how it was made.
 *
 * Runs inside `waitUntil`: it must never fail a signup. The user is registered
 * either way, so every failure here is swallowed into the audit table rather
 * than surfaced.
 */
export async function recordSignupConversion(
    env: Parameters<typeof reportConversion>[0],
    user: Pick<UserRow, 'id' | 'email'>,
    attribution: RedditAttribution,
    /** The signing-up browser's IP and user agent. Real match keys, and the
     *  only ones an organic signup has besides its hashed email — worth
     *  passing even though a click id is the stronger signal when present. */
    request: { ipAddress?: string | null; userAgent?: string | null } = {},
): Promise<void> {
    try {
        if (hasAttribution(attribution)) {
            await setUserRedditAttribution(env.arcane_db, user.id, {
                clickId: attribution.clickId,
                rdtUuid: attribution.rdtUuid,
            });
        }
        await reportConversion(env, {
            eventName: 'SignUp',
            // Derived, not random: one account can only ever be signed up
            // once, so a replay of this conversion — a manual re-send of a
            // failed audit row, say — collapses on Reddit's side instead of
            // inventing a second customer.
            conversionId: `signup:${user.id}`,
            userId: user.id,
            email: user.email,
            ipAddress: request.ipAddress ?? null,
            userAgent: request.userAgent ?? null,
            // Our own user id as a stable cross-event key, so a later Purchase
            // and this SignUp are recognisably the same person even if the
            // email match ever fails.
            externalId: String(user.id),
            clickId: attribution.clickId,
            rdtUuid: attribution.rdtUuid,
        });
    } catch (err) {
        console.error(JSON.stringify({
            event: 'reddit_signup_conversion_failed',
            userId: user.id,
            message: err instanceof Error ? err.message : String(err),
        }));
    }
}

/**
 * Report revenue for a user, attributed to the ad click that won them.
 *
 * The click id comes off the stored user row rather than the request, because
 * a payment can land weeks after the signup that captured it — and for a
 * webhook there is no browser in the loop at all. That delayed join is the
 * whole reason `users.rdt_click_id` is persisted instead of being consumed at
 * signup and discarded.
 *
 * Deliberately carries NO ip_address or user_agent, unlike the SignUp event.
 * The request this runs inside is Dodo's webhook call, so the only IP and UA
 * available belong to Dodo's servers — sending those as the USER's match keys
 * would not merely be weak, it would be wrong, and would attribute the
 * purchase to whoever else Reddit associates with that address.
 *
 * Never throws: a billing webhook must not fail over ad reporting, or Dodo
 * will retry a payment we have already applied.
 */
export async function reportUserPurchase(
    env: Parameters<typeof reportConversion>[0],
    userId: number,
    valueUsd: number,
    /** Stable identity for THIS payment — the Dodo subscription or payment id.
     *  Makes the conversion id derivable, so a webhook redelivered under a new
     *  event id cannot be counted as a second purchase. */
    paymentRef: string,
): Promise<void> {
    try {
        const user = await findUserById(env.arcane_db, userId);
        if (!user) return;
        await reportConversion(env, {
            eventName: 'Purchase',
            conversionId: `purchase:${paymentRef}`,
            userId: user.id,
            email: user.email,
            externalId: String(user.id),
            clickId: user.rdt_click_id,
            rdtUuid: user.rdt_uuid,
            valueDecimal: valueUsd,
            currency: 'USD',
        });
    } catch (err) {
        console.error(JSON.stringify({
            event: 'reddit_purchase_conversion_failed',
            userId,
            message: err instanceof Error ? err.message : String(err),
        }));
    }
}

/**
 * Run a side-effect without delaying the response, where a response context
 * exists to defer it onto.
 *
 * `c.executionCtx` THROWS when a Hono app is invoked without one — which is
 * exactly how the OAuth route tests drive these handlers (`router.request(...)`
 * rather than a real fetch). Reaching for it unguarded turns a conversion
 * report into a 500 on the sign-in itself, which is the failure this exists to
 * prevent. Falling back to awaiting also makes the effect observable in those
 * tests instead of being dropped.
 */
export async function runInBackground(
    ctx: { waitUntil(promise: Promise<unknown>): void } | undefined,
    promise: Promise<unknown>,
): Promise<void> {
    if (ctx) {
        ctx.waitUntil(promise);
        return;
    }
    await promise.catch(() => {});
}

/** `c.executionCtx`, or undefined when the runtime did not supply one. */
export function optionalExecutionCtx(
    c: { executionCtx: { waitUntil(promise: Promise<unknown>): void } },
): { waitUntil(promise: Promise<unknown>): void } | undefined {
    try {
        return c.executionCtx;
    } catch {
        return undefined;
    }
}
