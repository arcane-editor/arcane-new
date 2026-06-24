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
