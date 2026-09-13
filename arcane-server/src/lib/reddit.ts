/**
 * Reddit Conversions API (CAPI) client.
 *
 * Reports the conversions that happen where a browser pixel cannot see them:
 * an account being created, a subscription being paid for, and a desktop app
 * being launched for the first time. The one conversion that DOES happen in a
 * browser — the download click — is fired by the pixel instead, so nothing is
 * reported twice and there is no pixel/CAPI deduplication to get wrong.
 *
 * Schema verified against Reddit's v2.0 API. Two details are easy to get wrong
 * and are called out because a mistake in either fails silently as "Reddit
 * shows no conversions":
 *  - `click_id` sits at the EVENT root, not inside `user`.
 *  - the match keys in `user` are SHA-256 HEX of a normalized value, and an
 *    unhashed value is accepted by the API but matches nobody.
 *
 * Delivery is fire-and-forget from inside `ctx.waitUntil` — a Reddit outage
 * must never make a signup or a payment fail — with one retry and an audit
 * row per attempt in `reddit_conversions`. That table is the record of what we
 * told Reddit, and it is deliberately the same shape a queue drain would read
 * if this ever needs to become self-healing.
 */

import { createRedditConversion } from './db.ts';

export const REDDIT_API_VERSION = 'v2.0';

/** Reddit's standard conversion events. `Custom` carries `custom_event_name`. */
export type RedditTrackingType =
    | 'PageVisit' | 'ViewContent' | 'Search' | 'AddToCart'
    | 'AddToWishlist' | 'Purchase' | 'Lead' | 'SignUp' | 'Custom';

/** Match keys. Every field here except `user_agent` and `uuid` is a SHA-256
 *  hex digest by the time it reaches this shape. */
export interface RedditUserPayload {
    email?: string;
    external_id?: string;
    ip_address?: string;
    user_agent?: string;
    uuid?: string;
}

export interface RedditEventPayload {
    event_at: string;
    event_type: { tracking_type: RedditTrackingType; custom_event_name?: string };
    click_id?: string;
    user?: RedditUserPayload;
    event_metadata?: {
        conversion_id?: string;
        currency?: string;
        value_decimal?: number;
        item_count?: number;
    };
}

export interface RedditRequestBody {
    test_mode?: boolean;
    events: RedditEventPayload[];
}

/** What a caller describes; everything optional except the event identity. */
export interface ConversionInput {
    /** Audit name AND, for standard events, the tracking_type. */
    eventName: 'SignUp' | 'Purchase' | 'Install';
    /** Stable idempotency key echoed to Reddit. Defaults to a fresh UUID. */
    conversionId?: string;
    eventAt?: Date;
    clickId?: string | null;
    rdtUuid?: string | null;
    email?: string | null;
    /** Our own stable id for the subject — a user id or an install id. */
    externalId?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
    valueDecimal?: number;
    currency?: string;
    /** Recorded on the audit row so a conversion can be traced to a person. */
    userId?: number | null;
    installId?: string | null;
}

export interface RedditConfig {
    token: string;
    /** Reddit ad account id — the same `a2_…` string as the pixel id. */
    accountId: string;
    testMode: boolean;
}

export type ConversionStatus = 'ok' | 'failed' | 'skipped';

export interface ConversionResult {
    status: ConversionStatus;
    httpStatus?: number;
    error?: string;
    conversionId: string;
}

// ─── Hashing ────────────────────────────────────────────────

/** Lowercase hex SHA-256, the digest form Reddit's match keys use. */
export async function sha256Hex(value: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Already a SHA-256 hex digest? Guards against double-hashing a value that
 *  some caller has helpfully pre-hashed, which would match nobody. */
export function looksHashed(value: string): boolean {
    return /^[a-f0-9]{64}$/i.test(value);
}

/**
 * Email normalization before hashing: lowercase and trim, nothing else.
 *
 * Deliberately NOT the gmail-style canonicalization (stripping dots and
 * `+suffix`) that some CAPI integrations apply. Reddit's own pixel hashes the
 * lowercased, trimmed address, so anything cleverer here produces a digest
 * that disagrees with the pixel's for the same person — silently halving match
 * quality in a way nothing surfaces.
 */
export function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

/** Hash a match key, passing through a value that is already a digest. */
async function hashKey(value: string, normalize: (v: string) => string): Promise<string> {
    const trimmed = value.trim();
    return looksHashed(trimmed) ? trimmed.toLowerCase() : sha256Hex(normalize(trimmed));
}

// ─── Payload ────────────────────────────────────────────────

/** Drop empty strings so absent match keys are omitted rather than sent blank —
 *  Reddit treats a present-but-empty key as a key, and matches nothing. */
function clean(value: string | null | undefined): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}

/** The `event_type` for one of our three events. Install is the only custom
 *  one — Reddit has no native app-install event for a web pixel account. */
export function eventTypeFor(eventName: ConversionInput['eventName']): RedditEventPayload['event_type'] {
    return eventName === 'Install'
        ? { tracking_type: 'Custom', custom_event_name: 'Install' }
        : { tracking_type: eventName };
}

/** Build the wire payload for one conversion, hashing every match key. */
export async function buildEvent(input: ConversionInput, conversionId: string): Promise<RedditEventPayload> {
    const user: RedditUserPayload = {};

    const email = clean(input.email);
    if (email) user.email = await hashKey(email, normalizeEmail);

    const externalId = clean(input.externalId);
    if (externalId) user.external_id = await hashKey(externalId, (v) => v);

    const ip = clean(input.ipAddress);
    if (ip) user.ip_address = await hashKey(ip, (v) => v);

    const userAgent = clean(input.userAgent);
    if (userAgent) user.user_agent = userAgent;

    const uuid = clean(input.rdtUuid);
    if (uuid) user.uuid = uuid;

    const event: RedditEventPayload = {
        event_at: (input.eventAt ?? new Date()).toISOString(),
        event_type: eventTypeFor(input.eventName),
        event_metadata: { conversion_id: conversionId },
    };

    const clickId = clean(input.clickId);
    if (clickId) event.click_id = clickId;
    if (Object.keys(user).length > 0) event.user = user;

    if (typeof input.valueDecimal === 'number' && Number.isFinite(input.valueDecimal)) {
        event.event_metadata!.value_decimal = input.valueDecimal;
        event.event_metadata!.currency = input.currency ?? 'USD';
        event.event_metadata!.item_count = 1;
    }

    return event;
}

/**
 * Whether Reddit can do anything with this event.
 *
 * An event with no click id and no match key is accepted with a 200 and then
 * attributed to nobody. Sending those would make the audit table read as a
 * wall of successes while the campaign reports nothing, so they are refused
 * here and recorded as skipped instead.
 */
export function hasIdentity(event: RedditEventPayload): boolean {
    return Boolean(event.click_id) || Object.keys(event.user ?? {}).length > 0;
}

// ─── Configuration ──────────────────────────────────────────

/**
 * Credentials, or null when the integration is not configured.
 *
 * Null is a supported state, not an error: it is how the Worker behaves before
 * the owner sets the secret, and it mirrors how `DODO_API_KEY` degrades here.
 * The call becomes a recorded no-op rather than a 500 on a signup.
 */
export function redditConfig(env: {
    REDDIT_CONVERSION_TOKEN?: string;
    REDDIT_AD_ACCOUNT_ID?: string;
    ENVIRONMENT?: string;
}): RedditConfig | null {
    const token = clean(env.REDDIT_CONVERSION_TOKEN);
    const accountId = clean(env.REDDIT_AD_ACCOUNT_ID);
    if (!token || !accountId) return null;
    // Anything that is not the production Worker reports in test mode, where
    // Reddit validates and echoes the event but counts no conversion. That is
    // what makes it safe for dev to share one pixel id with live ad spend.
    return { token, accountId, testMode: env.ENVIRONMENT !== 'production' };
}

export function conversionsUrl(accountId: string): string {
    return `https://ads-api.reddit.com/api/${REDDIT_API_VERSION}/conversions/events/${encodeURIComponent(accountId)}`;
}

// ─── Delivery ───────────────────────────────────────────────

/** Status codes worth a second attempt: rate limits and transient server
 *  faults. A 4xx is our bug and retrying just sends the same bad payload. */
function isRetryable(status: number): boolean {
    return status === 429 || status >= 500;
}

export interface PostOutcome {
    ok: boolean;
    httpStatus?: number;
    error?: string;
}

/**
 * POST one event, retrying once on a transient failure.
 *
 * `fetchImpl` is injectable so the whole delivery path — including the retry
 * and the error-body truncation — is testable without a network.
 */
export async function postEvent(
    config: RedditConfig,
    event: RedditEventPayload,
    fetchImpl: typeof fetch = fetch,
    attempts = 2,
): Promise<PostOutcome> {
    const body: RedditRequestBody = { test_mode: config.testMode, events: [event] };
    let last: PostOutcome = { ok: false, error: 'not attempted' };

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const res = await fetchImpl(conversionsUrl(config.accountId), {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${config.token}`,
                    'Content-Type': 'application/json',
                    // Reddit's API gateway rejects requests with no UA.
                    'User-Agent': 'unityide-server/1.0',
                },
                body: JSON.stringify(body),
            });
            if (res.ok) return { ok: true, httpStatus: res.status };

            // Truncated: an HTML error page from an edge proxy would otherwise
            // land whole in a D1 column.
            const text = (await res.text().catch(() => '')).slice(0, 500);
            last = { ok: false, httpStatus: res.status, error: text || `HTTP ${res.status}` };
            if (!isRetryable(res.status)) return last;
        } catch (err) {
            last = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    return last;
}

/**
 * Report a conversion: build it, send it, and record what happened.
 *
 * Never throws and never rejects. It runs inside `waitUntil`, where an
 * unhandled rejection is both invisible and useless — every failure mode ends
 * as a row in `reddit_conversions` instead.
 */
export async function reportConversion(
    env: {
        arcane_db: D1Database;
        REDDIT_CONVERSION_TOKEN?: string;
        REDDIT_AD_ACCOUNT_ID?: string;
        ENVIRONMENT?: string;
    },
    input: ConversionInput,
    fetchImpl: typeof fetch = fetch,
): Promise<ConversionResult> {
    const conversionId = input.conversionId ?? crypto.randomUUID();
    const config = redditConfig(env);

    const audit = async (status: ConversionStatus, httpStatus?: number, error?: string): Promise<ConversionResult> => {
        try {
            await createRedditConversion(env.arcane_db, {
                eventName: input.eventName,
                conversionId,
                userId: input.userId ?? null,
                installId: input.installId ?? null,
                clickId: input.clickId ?? null,
                status,
                httpStatus: httpStatus ?? null,
                error: error ? error.slice(0, 500) : null,
                testMode: config?.testMode ?? false,
            });
        } catch (err) {
            // The audit write failing must not escalate into a failed request.
            console.error(JSON.stringify({
                event: 'reddit_audit_write_failed',
                conversionId,
                message: err instanceof Error ? err.message : String(err),
            }));
        }
        return { status, httpStatus, error, conversionId };
    };

    try {
        if (!config) return await audit('skipped', undefined, 'reddit_not_configured');

        const event = await buildEvent(input, conversionId);
        if (!hasIdentity(event)) return await audit('skipped', undefined, 'no_match_keys');

        const outcome = await postEvent(config, event, fetchImpl);
        return await audit(outcome.ok ? 'ok' : 'failed', outcome.httpStatus, outcome.error);
    } catch (err) {
        return await audit('failed', undefined, err instanceof Error ? err.message : String(err));
    }
}
