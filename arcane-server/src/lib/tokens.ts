// One-time-secret primitives for the auth_tokens table. Raw tokens are
// handed to the caller exactly once; only their SHA-256 hex lands in D1.

export const TOKEN_TTL_SECONDS = {
    verify_email: 24 * 60 * 60,   // 24 h
    password_reset: 30 * 60,      // 30 min
    web_login: 60,                // 60 s (Google → website handoff code)
    editor_login: 60,             // 60 s (website → editor handoff code)
} as const;

export type TokenPurpose = keyof typeof TOKEN_TTL_SECONDS;

export function toBase64Url(bytes: Uint8Array): string {
    let bin = '';
    for (const b of bytes) { bin += String.fromCharCode(b); }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 random bytes as base64url — always 43 chars, no padding. */
export function generateToken(): string {
    return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Hex(input: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** PKCE S256: base64url(SHA-256(ascii(verifier))). RFC 7636 §4.2. */
export async function s256Challenge(verifier: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return toBase64Url(new Uint8Array(digest));
}
