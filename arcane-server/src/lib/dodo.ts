// Dodo Payments integration: outbound Checkout Session creation + inbound
// webhook signature verification. Dodo is a Merchant-of-Record; we never touch
// card data. Webhooks follow the Standard Webhooks spec (HMAC-SHA256), verified
// here with WebCrypto — no third-party dependency, so it's exact and testable.

// Base URL by environment. Dodo exposes separate test/live hosts + keys.
export function dodoApiBase(environment: string | undefined): string {
    return environment === 'production' ? 'https://live.dodopayments.com' : 'https://test.dodopayments.com';
}

// ─── Webhook signature verification (Standard Webhooks) ──────────────────────
// Signed content is `${webhook-id}.${webhook-timestamp}.${raw-body}`; the
// `webhook-signature` header is a space-separated list of `v1,<base64 hmac>`.
// The secret may carry a `whsec_` prefix and is base64 after that prefix.

const FIVE_MINUTES_MS = 5 * 60 * 1000;

function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function bytesToBase64(bytes: ArrayBuffer): string {
    const arr = new Uint8Array(bytes);
    let bin = '';
    for (const b of arr) bin += String.fromCharCode(b);
    return btoa(bin);
}

/** Constant-time string compare (both already ASCII base64). */
function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

export interface WebhookHeaders {
    id: string | undefined;
    timestamp: string | undefined;
    signature: string | undefined;
}

/**
 * Verify a Standard-Webhooks payload. Returns true only when a signature in the
 * header matches AND the timestamp is within ±5 min (replay protection). Any
 * missing header, bad secret, or stale timestamp → false (caller returns 400).
 */
export async function verifyDodoWebhook(
    secret: string, headers: WebhookHeaders, rawBody: string,
): Promise<boolean> {
    const { id, timestamp, signature } = headers;
    if (!id || !timestamp || !signature) return false;

    const tsMs = Number(timestamp) * 1000;
    if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > FIVE_MINUTES_MS) return false;

    let keyBytes: Uint8Array;
    try {
        keyBytes = base64ToBytes(secret.replace(/^whsec_/, ''));
    } catch {
        return false;
    }

    const key = await crypto.subtle.importKey(
        'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const signedContent = `${id}.${timestamp}.${rawBody}`;
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedContent));
    const expected = bytesToBase64(mac);

    // Header may carry multiple space-separated `version,signature` entries.
    return signature.split(' ').some((part) => {
        const comma = part.indexOf(',');
        const sig = comma === -1 ? part : part.slice(comma + 1);
        return timingSafeEqual(sig, expected);
    });
}

/** Produce a `v1,<base64 hmac>` signature for the signed content — the exact
 *  inverse of verifyDodoWebhook. Used by tests (and documents the scheme). */
export async function signDodoWebhook(
    secret: string, id: string, timestamp: string, rawBody: string,
): Promise<string> {
    const keyBytes = base64ToBytes(secret.replace(/^whsec_/, ''));
    const key = await crypto.subtle.importKey(
        'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`));
    return `v1,${bytesToBase64(mac)}`;
}

// ─── Checkout Session creation ───────────────────────────────────────────────
// NOTE: confirm the exact endpoint + body against Dodo's live API reference when
// the owner provisions products (docs.dodopayments.com). The shape below follows
// the documented Checkout Session flow: POST /checkouts with a product cart, a
// return_url, and our own metadata (which Dodo echoes back on webhooks — that's
// how we map an event to a user, decoupled from Dodo's object shapes).

export interface CheckoutParams {
    apiKey: string;
    apiBase: string;
    productId: string;
    isSubscription: boolean;
    returnUrl: string;
    /** Echoed back on webhook events — our source of truth for who/what. */
    metadata: { arcane_user_id: string; arcane_kind: 'subscription' | 'topup'; arcane_ref: string };
    customerEmail?: string;
    dodoCustomerId?: string;
}

export interface CheckoutResult {
    checkoutUrl: string;
    sessionId?: string;
}

export async function createDodoCheckout(params: CheckoutParams): Promise<CheckoutResult> {
    const body: Record<string, unknown> = {
        product_cart: [{ product_id: params.productId, quantity: 1 }],
        return_url: params.returnUrl,
        metadata: params.metadata,
    };
    if (params.dodoCustomerId) body.customer = { customer_id: params.dodoCustomerId };
    else if (params.customerEmail) body.customer = { email: params.customerEmail };

    const res = await fetch(`${params.apiBase}/checkouts`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${params.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Dodo checkout failed (${res.status}): ${detail.slice(0, 200)}`);
    }

    const json = await res.json<{ checkout_url?: string; url?: string; session_id?: string; id?: string }>();
    const checkoutUrl = json.checkout_url ?? json.url;
    if (!checkoutUrl) throw new Error('Dodo checkout returned no checkout_url');
    return { checkoutUrl, sessionId: json.session_id ?? json.id };
}

/** Hosted customer-portal link for managing/cancelling a subscription. NOTE:
 *  confirm the endpoint against Dodo's live API when wiring real products. */
export async function createDodoCustomerPortal(
    apiKey: string, apiBase: string, customerId: string,
): Promise<string> {
    const res = await fetch(`${apiBase}/customers/${encodeURIComponent(customerId)}/customer-portal/session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: '{}',
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Dodo portal failed (${res.status}): ${detail.slice(0, 200)}`);
    }
    const json = await res.json<{ link?: string; url?: string }>();
    const link = json.link ?? json.url;
    if (!link) throw new Error('Dodo portal returned no link');
    return link;
}
