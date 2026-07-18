import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
    createAuthToken, consumeAuthToken, countRecentAuthTokens, cleanExpiredAuthTokens,
    createOAuthUser, findUserByGoogleSub, linkGoogleSub, setEmailVerified,
    updatePasswordBumpVersion, bumpTokenVersion, createUser,
} from '../src/lib/db.ts';
import { generateToken, sha256Hex } from '../src/lib/tokens.ts';

async function seedUser(email: string): Promise<{ id: number }> {
    const row = await env.arcane_db.prepare(
        "INSERT INTO users (email, password_hash, salt) VALUES (?, 'x', 'y') RETURNING id"
    ).bind(email).first<{ id: number }>();
    return row!;
}

describe('auth_tokens helpers', () => {
    it('createAuthToken stores only the hash with a future expiry', async () => {
        const user = await seedUser('a@test.dev');
        const hash = await sha256Hex(generateToken());
        const row = await createAuthToken(env.arcane_db, {
            userId: user.id, purpose: 'verify_email', tokenHash: hash, ttlSeconds: 86400,
        });
        expect(row.token_hash).toBe(hash);
        expect(row.consumed_at).toBeNull();
        expect(row.meta).toBeNull();
    });

    it('consumeAuthToken is single-use even under concurrent consumption', async () => {
        const user = await seedUser('race@test.dev');
        const hash = await sha256Hex(generateToken());
        await createAuthToken(env.arcane_db, {
            userId: user.id, purpose: 'web_login', tokenHash: hash, ttlSeconds: 60,
        });
        const results = await Promise.all([
            consumeAuthToken(env.arcane_db, 'web_login', hash),
            consumeAuthToken(env.arcane_db, 'web_login', hash),
        ]);
        expect(results.filter((r) => r !== null)).toHaveLength(1);
    });

    it('consumeAuthToken rejects expired and wrong-purpose tokens', async () => {
        const user = await seedUser('exp@test.dev');
        const hash = await sha256Hex(generateToken());
        await env.arcane_db.prepare(
            `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
             VALUES (?, 'web_login', ?, datetime('now', '-10 seconds'))`
        ).bind(user.id, hash).run();
        expect(await consumeAuthToken(env.arcane_db, 'web_login', hash)).toBeNull();

        const hash2 = await sha256Hex(generateToken());
        await createAuthToken(env.arcane_db, {
            userId: user.id, purpose: 'editor_login', tokenHash: hash2, ttlSeconds: 60,
        });
        expect(await consumeAuthToken(env.arcane_db, 'web_login', hash2)).toBeNull();
    });

    it('countRecentAuthTokens counts the last hour per purpose; clean removes expired', async () => {
        const user = await seedUser('count@test.dev');
        for (let i = 0; i < 3; i++) {
            await createAuthToken(env.arcane_db, {
                userId: user.id, purpose: 'verify_email',
                tokenHash: await sha256Hex(generateToken()), ttlSeconds: 86400,
            });
        }
        expect(await countRecentAuthTokens(env.arcane_db, user.id, 'verify_email')).toBe(3);
        expect(await countRecentAuthTokens(env.arcane_db, user.id, 'password_reset')).toBe(0);

        await env.arcane_db.prepare(
            `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
             VALUES (?, 'web_login', 'dead', datetime('now', '-10 seconds'))`
        ).bind(user.id).run();
        await cleanExpiredAuthTokens(env.arcane_db);
        const left = await env.arcane_db.prepare(
            "SELECT COUNT(*) AS n FROM auth_tokens WHERE token_hash = 'dead'"
        ).first<{ n: number }>();
        expect(left!.n).toBe(0);
    });
});

describe('user auth helpers', () => {
    it('createOAuthUser creates a verified passwordless user findable by google_sub', async () => {
        const user = await createOAuthUser(env.arcane_db, { email: 'G@Test.dev', googleSub: 'sub-1' });
        expect(user.email).toBe('g@test.dev');
        expect(user.password_hash).toBe('');
        expect(user.email_verified).toBe(1);
        expect(user.token_version).toBe(0);
        const found = await findUserByGoogleSub(env.arcane_db, 'sub-1');
        expect(found?.id).toBe(user.id);
    });

    it('linkGoogleSub sets google_sub and email_verified', async () => {
        const seed = await seedUser('link@test.dev');
        const user = await linkGoogleSub(env.arcane_db, seed.id, 'sub-2');
        expect(user?.google_sub).toBe('sub-2');
        expect(user?.email_verified).toBe(1);
    });

    it('setEmailVerified flips the flag; new users default to unverified', async () => {
        const seed = await seedUser('v@test.dev');
        const before = await env.arcane_db.prepare('SELECT email_verified FROM users WHERE id = ?')
            .bind(seed.id).first<{ email_verified: number }>();
        expect(before!.email_verified).toBe(0);
        const user = await setEmailVerified(env.arcane_db, seed.id);
        expect(user?.email_verified).toBe(1);
    });

    it('updatePasswordBumpVersion and bumpTokenVersion increment token_version', async () => {
        const seed = await seedUser('bump@test.dev');
        const u1 = await updatePasswordBumpVersion(env.arcane_db, seed.id, 'newhash', 'newsalt');
        expect(u1?.password_hash).toBe('newhash');
        expect(u1?.token_version).toBe(1);
        const u2 = await bumpTokenVersion(env.arcane_db, seed.id);
        expect(u2?.token_version).toBe(2);
    });

    it('createUser honors the emailVerified flag (admin-created users)', async () => {
        const u = await createUser(env.arcane_db, {
            email: 'admin-made@test.dev', passwordHash: 'h', salt: 's', emailVerified: true,
        });
        expect(u.email_verified).toBe(1);
    });
});
