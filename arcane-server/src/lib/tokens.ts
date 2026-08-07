// One-time-secret primitives for the auth_tokens table. Raw tokens are
// handed to the caller exactly once; only their SHA-256 hex lands in D1.

export const TOKEN_TTL_SECONDS = {
    verify_email: 24 * 60 * 60,   // 24 h
    password_reset: 30 * 60,      // 30 min
    web_login: 60,                // 60 s (Google → website handoff code)
    // Emailed 6-digit sign-in code. Short by design: the code is guessable in
    // a way the 256-bit link tokens are not, so its life is the main lever
    // limiting how long an attacker has to work against it.
    otp_login: 10 * 60,           // 10 min
    // `editor_login` retired in 0016: the website → editor handoff code now
    // lives on the editor_attempts row (see src/lib/attempts.ts), which binds
    // it to a PKCE challenge and gives the poll channel something to consume.
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

const OTP_SPACE = 1_000_000;
/** Largest multiple of OTP_SPACE that fits in a uint32. Values at or above it
 *  are discarded rather than folded, because 2^32 is not a multiple of 10^6 —
 *  plain `% 1e6` would make the low codes measurably more likely. */
const OTP_CEILING = Math.floor(0x1_0000_0000 / OTP_SPACE) * OTP_SPACE;

/** Uniform 6-digit code, zero-padded (so "000042" is as likely as "999999"). */
export function generateOtp(): string {
    const buf = new Uint32Array(1);
    let n: number;
    do {
        crypto.getRandomValues(buf);
        n = buf[0]!;
    } while (n >= OTP_CEILING);
    return String(n % OTP_SPACE).padStart(6, '0');
}

/** Codes are stored as sha256(userId:code), never bare.
 *
 *  Binding the user id in does two jobs: `auth_tokens.token_hash` is UNIQUE and
 *  a 6-digit space collides readily between concurrent users, and it makes a
 *  code minted for one account useless against another. */
export function otpHash(userId: number, code: string): Promise<string> {
    return sha256Hex(`${userId}:${code}`);
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
