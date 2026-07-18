// Editor deep-link login flow: pure validators + sessionStorage plumbing.
// Framework-free on purpose — a lightweight vitest could cover the pure
// functions later (documented option; no test harness exists in landing-page
// today and this module must not require one).

export const SCHEME_ALLOWLIST = ['arcane', 'arcane-dev'] as const;
export type EditorScheme = (typeof SCHEME_ALLOWLIST)[number];

export interface EditorLoginRequest {
    state: string;      // app-generated CSRF token, echoed verbatim in the deep link (1-256 chars)
    challenge: string;  // PKCE S256 challenge, base64url 43-128 chars
    scheme: EditorScheme;
}

export interface EditorHandoff {
    deepLink: string;   // `${scheme}://auth/callback?code=...&state=...`
    code: string;       // one-time grant code (~60s TTL) for the manual-paste fallback
}

const REQUEST_KEY = 'arcane_editor_login_request';
const HANDOFF_KEY = 'arcane_editor_login_handoff';
const RETURN_KEY = 'arcane_post_auth_return';

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const DEEP_LINK_RE = /^(arcane|arcane-dev):\/\/auth\/callback\?/;

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

export type EditorLoginParseResult =
    | { ok: true; request: EditorLoginRequest }
    | { ok: false; error: string };

/** Parse `?flow=editor&state=&challenge=&scheme=` params. Caller has already
 *  checked `flow === 'editor'`. Never builds a deep link on failure. */
export function parseEditorLoginParams(params: URLSearchParams): EditorLoginParseResult {
    const state = params.get('state') ?? '';
    const challenge = params.get('challenge') ?? '';
    const scheme = params.get('scheme') ?? '';
    if (!isAllowedScheme(scheme)) {
        return {
            ok: false,
            error: `This sign-in link asked to open an app link ("${scheme || 'none'}://") this site doesn't recognize, so we stopped for your safety. Update Arcane, then click Sign in again from the editor.`,
        };
    }
    if (!isValidChallenge(challenge)) {
        return { ok: false, error: 'The sign-in link from the editor is malformed (bad challenge). Return to Arcane and click Sign in again.' };
    }
    if (!isValidState(state)) {
        return { ok: false, error: 'The sign-in link from the editor is malformed (bad state). Return to Arcane and click Sign in again.' };
    }
    return { ok: true, request: { state, challenge, scheme } };
}

export function buildDeepLink(scheme: EditorScheme, code: string, state: string): string {
    return `${scheme}://auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
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
        // Re-validate on load — sessionStorage is same-origin writable; never trust it blindly.
        if (!isAllowedScheme(parsed.scheme) || !isValidChallenge(parsed.challenge) || !isValidState(parsed.state)) {
            sessionStorage.removeItem(REQUEST_KEY);
            return null;
        }
        return parsed;
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
            || parsed.code.length === 0 || !DEEP_LINK_RE.test(parsed.deepLink)) {
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
