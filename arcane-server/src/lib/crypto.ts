const ITERATIONS = 100_000;
const KEY_LENGTH = 32;
const HASH_ALGO = 'SHA-256';

export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(password),
        'PBKDF2',
        false,
        ['deriveBits'],
    );
    const derivedBits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: HASH_ALGO },
        keyMaterial,
        KEY_LENGTH * 8,
    );
    return {
        hash: bufToHex(new Uint8Array(derivedBits)),
        salt: bufToHex(salt),
    };
}

export async function verifyPassword(password: string, storedHash: string, storedSalt: string): Promise<boolean> {
    const salt = hexToBuf(storedSalt);
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(password),
        'PBKDF2',
        false,
        ['deriveBits'],
    );
    const derivedBits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: HASH_ALGO },
        keyMaterial,
        KEY_LENGTH * 8,
    );
    return bufToHex(new Uint8Array(derivedBits)) === storedHash;
}

function bufToHex(buf: Uint8Array): string {
    return [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBuf(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
}

// ─── Constant-time secret compare (admin login) ──────────────────────────
// Hashing first fixes both operands at a 32-byte SHA-256 digest, so a raw
// input-length mismatch (e.g. a short guess vs the real secret) never leaks
// anything through timing — only digest content differences remain, and
// those are compared with an XOR-accumulate loop that never exits early.

async function sha256(input: string): Promise<Uint8Array> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return new Uint8Array(digest);
}

/** Same XOR-accumulate pattern as src/lib/dodo.ts's timingSafeEqual, adapted
 *  from ASCII chars to raw bytes. */
function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
    return diff === 0;
}

/** Digest both inputs (SHA-256) then constant-time compare the digests.
 *  Used by admin login to compare the supplied password against
 *  ADMIN_PASSWORD without a length or early-exit timing side-channel. */
export async function digestsMatch(a: string, b: string): Promise<boolean> {
    const [da, db] = await Promise.all([sha256(a), sha256(b)]);
    return timingSafeEqualBytes(da, db);
}
