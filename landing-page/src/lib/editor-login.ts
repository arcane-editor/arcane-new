// Editor login flow: pure validators + sessionStorage plumbing.
// Framework-free on purpose — covered by src/lib/editor-login.test.ts (vitest).

export const SCHEME_ALLOWLIST = ['arcane', 'arcane-dev'] as const;
export type EditorScheme = (typeof SCHEME_ALLOWLIST)[number];

/** Where the website sends the browser once it holds the grant code.
 *  Exactly one form per request — the union makes "both" unrepresentable. */
export type EditorCallbackTarget =
    | { kind: 'scheme'; scheme: EditorScheme }
    | { kind: 'loopback'; redirectUri: string };

export interface EditorLoginRequest {
    state: string;      // app-generated CSRF token, echoed verbatim in the callback (1-256 chars)
    challenge: string;  // PKCE S256 challenge, base64url 43-128 chars
    target: EditorCallbackTarget;
}

export interface EditorHandoff {
    deepLink: string;   // scheme callback (`${scheme}://auth/callback?...`) or loopback callback (`http://127.0.0.1:<port>/callback?...`)
    code: string;       // one-time grant code (~60s TTL) for the manual-paste fallback
}

const REQUEST_KEY = 'arcane_editor_login_request';
const HANDOFF_KEY = 'arcane_editor_login_handoff';
const RETURN_KEY = 'arcane_post_auth_return';

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;
// Derived from SCHEME_ALLOWLIST so the two can't drift apart — schemes are
// always `[a-z-]`, so no escaping is needed in the alternation.
const CALLBACK_RE = new RegExp(
    `^((${SCHEME_ALLOWLIST.join('|')})://auth/callback\\?|http://(127\\.0\\.0\\.1|\\[::1\\]):\\d{4,5}/callback\\?)`,
);

// ─── Pure validators ────────────────────────────────────────

export function isAllowedScheme(scheme: string): scheme is EditorScheme {
    return (SCHEME_ALLOWLIST as readonly string[]).includes(scheme);
}

export function isValidChallenge(challenge: string): boolean {
    return CHALLENGE_RE.test(challenge);
}

export function isValidState(state: string): boolean {
    return state.length >= 1 && state.length <= 256;
}

// Loopback IP literals only. `localhost` is deliberately excluded: it resolves
// through DNS and is therefore rebindable, whereas an IP literal is not.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);

/** Validate `raw` as the app's loopback callback and return the CANONICAL
 *  form — never the raw input — or `null` if it doesn't qualify.
 *
 *  `URL` itself normalizes alternate loopback spellings (decimal/octal/hex
 *  IPv4, the `127.1` short form, expanded IPv6, fullwidth Unicode digits,
 *  a trailing dot, an uppercase scheme, spliced tab/newline in the port)
 *  down to `u.hostname` — they all genuinely resolve to loopback, so they
 *  are accepted, but ONLY the reconstructed `http://${u.hostname}:${port}/callback`
 *  is ever handed back. Building the result from those already-normalized
 *  fields — rather than returning `raw` — is what makes the validated value
 *  and the used value the same string: callers can no longer smuggle an
 *  alternate encoding through validation and then act on the raw text.
 *
 *  Rejects anything that isn't exactly this shape once normalized — no
 *  query, no fragment, no credentials, no privileged port. */
export function canonicalLoopbackRedirect(raw: string): string | null {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    // Browsers normalize `\` to `/`, which is how `/\evil.com` becomes a
    // protocol-relative URL. Reject outright rather than enumerate bypasses.
    if (raw.includes('\\')) return null;
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return null;
    }
    if (u.protocol !== 'http:') return null;
    if (!LOOPBACK_HOSTS.has(u.hostname)) return null;
    if (u.username !== '' || u.password !== '') return null;
    if (u.pathname !== '/callback') return null;
    if (u.search !== '' || u.hash !== '') return null;
    // An absent port makes u.port the empty string, and Number('') is 0 (not
    // NaN) — it's the `port >= 1024` bound below, not a NaN check, that
    // rejects the missing/default-port case.
    const port = Number(u.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
    return `http://${u.hostname}:${port}/callback`;
}

/** Strict shape check for the app's loopback callback — the boolean
 *  projection of `canonicalLoopbackRedirect`. Prefer that function when the
 *  canonical string is actually going to be stored or used. */
export function isValidLoopbackRedirect(raw: string): boolean {
    return canonicalLoopbackRedirect(raw) !== null;
}

export type EditorLoginParseResult =
    | { ok: true; request: EditorLoginRequest }
    | { ok: false; error: string };

/** Parse `?flow=editor&state=&challenge=&scheme=|redirect_uri=` params. Caller
 *  has already checked `flow === 'editor'`. Never builds a callback URL on failure. */
export function parseEditorLoginParams(params: URLSearchParams): EditorLoginParseResult {
    const state = params.get('state') ?? '';
    const challenge = params.get('challenge') ?? '';
    const scheme = params.get('scheme');
    const redirectUri = params.get('redirect_uri');

    if (scheme !== null && redirectUri !== null) {
        return {
            ok: false,
            error: 'The sign-in link from the editor is malformed (it names two different ways to return). Return to Arcane and click Sign in again.',
        };
    }

    let target: EditorCallbackTarget;
    if (redirectUri !== null) {
        // Store the CANONICAL string, not the raw query param: this is the
        // value that gets persisted and later interpolated into the
        // browser-facing callback URL, so it must be the same string that
        // was actually validated (see canonicalLoopbackRedirect above).
        const canonical = canonicalLoopbackRedirect(redirectUri);
        if (canonical === null) {
            return {
                ok: false,
                error: "This sign-in link asked to return to an address this site doesn't recognize, so we stopped for your safety. Update Arcane, then click Sign in again from the editor.",
            };
        }
        target = { kind: 'loopback', redirectUri: canonical };
    } else {
        // scheme is attacker-controllable (a raw query param) and gets echoed into
        // this hard-error banner — truncate so it can't carry a paragraph of
        // spoofed content into a trusted-looking message.
        if (!isAllowedScheme(scheme ?? '')) {
            const raw = scheme ?? '';
            const shown = raw.length > 20 ? `${raw.slice(0, 20)}…` : raw;
            return {
                ok: false,
                error: `This sign-in link asked to open an app link ("${shown || 'none'}://") this site doesn't recognize, so we stopped for your safety. Update Arcane, then click Sign in again from the editor.`,
            };
        }
        target = { kind: 'scheme', scheme: scheme as EditorScheme };
    }

    if (!isValidChallenge(challenge)) {
        return { ok: false, error: 'The sign-in link from the editor is malformed (bad challenge). Return to Arcane and click Sign in again.' };
    }
    if (!isValidState(state)) {
        return { ok: false, error: 'The sign-in link from the editor is malformed (bad state). Return to Arcane and click Sign in again.' };
    }
    return { ok: true, request: { state, challenge, target } };
}

export function buildCallbackUrl(
    target: EditorCallbackTarget,
    code: string,
    state: string,
): string {
    const query = `code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    return target.kind === 'scheme'
        ? `${target.scheme}://auth/callback?${query}`
        : `${target.redirectUri}?${query}`;
}

/** Internal post-login redirect target: must start with '/' but not '//'
 *  (blocks external and protocol-relative redirects). Null when rejected.
 *
 *  Origin-based validation: resolving `raw` against a fixed same-origin base
 *  and checking the result stayed on that origin defeats normalization
 *  tricks (e.g. backslash-as-slash: browsers treat `/\evil.com` as
 *  `//evil.com`, a protocol-relative URL to `evil.com`) in one shot, rather
 *  than trying to enumerate every bypass string pattern. */
export function sanitizeInternalReturn(raw: string | null): string | null {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    // Belt-and-suspenders: reject any backslash outright. Browsers normalize
    // `\` to `/` in URLs, which is exactly how `/\evil.com` (URL-encoded
    // `%2F%5Cevil.com`) becomes the protocol-relative `//evil.com`.
    if (raw.includes('\\')) return null;
    if (!raw.startsWith('/') || raw.startsWith('//')) return null;
    const BASE = 'https://arcaneai.org';
    let u: URL;
    try {
        u = new URL(raw, BASE);
    } catch {
        return null;
    }
    // The resolved URL must have stayed on the base origin — this is what
    // actually defeats normalization-based bypasses, independent of the
    // backslash check above.
    if (u.origin !== BASE) return null;
    if (!u.pathname.startsWith('/')) return null;
    return u.pathname + u.search + u.hash;
}

// ─── sessionStorage plumbing (SSR-safe) ─────────────────────

function storageAvailable(): boolean {
    return typeof window !== 'undefined' && !!window.sessionStorage;
}

export function saveEditorLoginRequest(req: EditorLoginRequest): void {
    if (!storageAvailable()) return;
    sessionStorage.setItem(REQUEST_KEY, JSON.stringify(req));
}

export function loadEditorLoginRequest(): EditorLoginRequest | null {
    if (!storageAvailable()) return null;
    const raw = sessionStorage.getItem(REQUEST_KEY);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as EditorLoginRequest;
        const t = parsed.target;
        // Re-validate on load — sessionStorage is same-origin writable; never
        // trust it blindly. For the loopback case this must re-derive the
        // canonical string (not just check a boolean): a same-origin write
        // could plant an alternate-encoded redirectUri directly in storage,
        // and returning it unchanged would smuggle raw, unvalidated text
        // back out — the exact bug this file exists to prevent.
        let target: EditorCallbackTarget | null = null;
        if (t && t.kind === 'scheme' && isAllowedScheme(t.scheme)) {
            target = t;
        } else if (t && t.kind === 'loopback') {
            const canonical = canonicalLoopbackRedirect(t.redirectUri);
            if (canonical !== null) target = { kind: 'loopback', redirectUri: canonical };
        }
        if (!target || !isValidChallenge(parsed.challenge) || !isValidState(parsed.state)) {
            sessionStorage.removeItem(REQUEST_KEY);
            return null;
        }
        return { ...parsed, target };
    } catch {
        sessionStorage.removeItem(REQUEST_KEY);
        return null;
    }
}

export function clearEditorLoginRequest(): void {
    if (storageAvailable()) sessionStorage.removeItem(REQUEST_KEY);
}

export function saveEditorHandoff(handoff: EditorHandoff): void {
    if (!storageAvailable()) return;
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(handoff));
}

export function loadEditorHandoff(): EditorHandoff | null {
    if (!storageAvailable()) return null;
    const raw = sessionStorage.getItem(HANDOFF_KEY);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as EditorHandoff;
        if (typeof parsed.deepLink !== 'string' || typeof parsed.code !== 'string'
            || parsed.code.length === 0 || !CALLBACK_RE.test(parsed.deepLink)) {
            sessionStorage.removeItem(HANDOFF_KEY);
            return null;
        }
        return parsed;
    } catch {
        sessionStorage.removeItem(HANDOFF_KEY);
        return null;
    }
}

export function clearEditorHandoff(): void {
    if (storageAvailable()) sessionStorage.removeItem(HANDOFF_KEY);
}

export function savePostAuthReturn(path: string): void {
    if (!storageAvailable()) return;
    if (sanitizeInternalReturn(path)) sessionStorage.setItem(RETURN_KEY, path);
}

/** Read-and-clear the stashed internal return path (sanitized again on read). */
export function takePostAuthReturn(): string | null {
    if (!storageAvailable()) return null;
    const raw = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    return sanitizeInternalReturn(raw);
}

/** Discard a stashed internal return path without honoring it — used when a
 *  superseding flow (e.g. editor sign-in) takes over instead. */
export function clearPostAuthReturn(): void {
    if (storageAvailable()) sessionStorage.removeItem(RETURN_KEY);
}
