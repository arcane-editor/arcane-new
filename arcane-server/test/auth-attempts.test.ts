import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { generateToken, s256Challenge } from '../src/lib/tokens.ts';
import { seedPasswordUser, tokenFor, jsonPost } from './helpers.ts';

async function newAttempt(): Promise<{ attemptId: string; verifier: string }> {
    const verifier = generateToken();
    const challenge = await s256Challenge(verifier);
    const res = await jsonPost('/v1/auth/editor/attempt', { challenge });
    expect(res.status).toBe(200);
    const body = await res.json<{ attempt_id: string; expires_in: number }>();
    return { attemptId: body.attempt_id, verifier };
}

async function grantFor(attemptId: string): Promise<string> {
    const user = await seedPasswordUser(`at-${crypto.randomUUID()}@test.dev`, 'password123');
    const res = await jsonPost('/v1/auth/editor/grant', { attempt_id: attemptId }, await tokenFor(user));
    expect(res.status).toBe(200);
    return (await res.json<{ code: string }>()).code;
}

describe('POST /v1/auth/editor/attempt', () => {
    it('creates a pending attempt bound to the challenge', async () => {
        const challenge = await s256Challenge(generateToken());
        const res = await jsonPost('/v1/auth/editor/attempt', { challenge });
        expect(res.status).toBe(200);
        const body = await res.json<{ attempt_id: string; expires_in: number }>();
        expect(body.attempt_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(body.expires_in).toBe(600);
    });

    it('rejects malformed challenges', async () => {
        for (const challenge of ['short', 'x'.repeat(129), `${'A'.repeat(42)}+`, '']) {
            const res = await jsonPost('/v1/auth/editor/attempt', { challenge });
            expect(res.status).toBe(400);
            expect(await res.json()).toEqual({ error: 'invalid_challenge' });
        }
    });

    it('requires no authentication (the app is signed out at this point)', async () => {
        const challenge = await s256Challenge(generateToken());
        const res = await jsonPost('/v1/auth/editor/attempt', { challenge });
        expect(res.status).toBe(200);
    });
});

describe('POST /v1/auth/editor/poll', () => {
    it('returns 428 while pending, then the session once granted', async () => {
        const { attemptId, verifier } = await newAttempt();

        const pending = await jsonPost('/v1/auth/editor/poll', { attempt_id: attemptId, verifier });
        expect(pending.status).toBe(428);
        expect(await pending.json()).toEqual({ error: 'authorization_pending' });

        await grantFor(attemptId);

        const done = await jsonPost('/v1/auth/editor/poll', { attempt_id: attemptId, verifier });
        expect(done.status).toBe(200);
        const body = await done.json<{ token: string; user: { plan: string } }>();
        expect(body.token).toBeTruthy();
        expect(body.user.plan).toBe('free');
    });

    it('does NOT consume a still-pending attempt (428 must be retryable)', async () => {
        const { attemptId, verifier } = await newAttempt();
        for (let i = 0; i < 3; i++) {
            const res = await jsonPost('/v1/auth/editor/poll', { attempt_id: attemptId, verifier });
            expect(res.status).toBe(428);
        }
        await grantFor(attemptId);
        const done = await jsonPost('/v1/auth/editor/poll', { attempt_id: attemptId, verifier });
        expect(done.status).toBe(200);
    });

    it('rejects a wrong verifier with the same opaque error', async () => {
        const { attemptId } = await newAttempt();
        await grantFor(attemptId);
        const res = await jsonPost(
            '/v1/auth/editor/poll', { attempt_id: attemptId, verifier: generateToken() },
        );
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'invalid_attempt' });
    });

    it('rejects an unknown attempt, a replay, and missing fields identically', async () => {
        const { attemptId, verifier } = await newAttempt();
        await grantFor(attemptId);
        expect((await jsonPost('/v1/auth/editor/poll', { attempt_id: attemptId, verifier })).status).toBe(200);

        for (const body of [
            { attempt_id: attemptId, verifier },              // replay
            { attempt_id: crypto.randomUUID(), verifier },    // unknown
            { attempt_id: attemptId },                        // no verifier
            { verifier },                                     // no attempt id
        ]) {
            const res = await jsonPost('/v1/auth/editor/poll', body);
            expect(res.status).toBe(400);
            expect(await res.json()).toEqual({ error: 'invalid_attempt' });
        }
    });

    it('rejects an expired attempt even though its code is still live', async () => {
        const verifier = generateToken();
        const challenge = await s256Challenge(verifier);
        const user = await seedPasswordUser(`exp-${crypto.randomUUID()}@test.dev`, 'password123');
        const attemptId = crypto.randomUUID();
        await env.arcane_db.prepare(
            `INSERT INTO editor_attempts
             (attempt_id, challenge, status, user_id, code_hash, code_expires_at, expires_at)
             VALUES (?, ?, 'authorized', ?, 'x', datetime('now', '+60 seconds'), datetime('now', '-10 seconds'))`
        ).bind(attemptId, challenge, user.id).run();

        const res = await jsonPost('/v1/auth/editor/poll', { attempt_id: attemptId, verifier });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'invalid_attempt' });
    });
});

describe('attempt → grant → exchange', () => {
    it('completes a full attempt-based login and returns plan + credits', async () => {
        const { attemptId, verifier } = await newAttempt();
        const code = await grantFor(attemptId);

        const res = await jsonPost('/v1/auth/editor/exchange', { code, verifier });
        expect(res.status).toBe(200);
        const body = await res.json<{
            token: string; user: { plan: string; credits: number; emailVerified: boolean };
        }>();
        expect(body.token).toBeTruthy();
        expect(body.user.plan).toBe('free');
        expect(typeof body.user.credits).toBe('number');
    });

    it('rejects a grant against an unknown attempt', async () => {
        const user = await seedPasswordUser(`unk-${crypto.randomUUID()}@test.dev`, 'password123');
        const res = await jsonPost(
            '/v1/auth/editor/grant', { attempt_id: crypto.randomUUID() }, await tokenFor(user),
        );
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'invalid_attempt' });
    });

    it('rejects a second grant against an already-authorized attempt', async () => {
        const { attemptId } = await newAttempt();
        await grantFor(attemptId);
        const user = await seedPasswordUser(`dbl-${crypto.randomUUID()}@test.dev`, 'password123');
        const res = await jsonPost('/v1/auth/editor/grant', { attempt_id: attemptId }, await tokenFor(user));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'invalid_attempt' });
    });

    it('still accepts the legacy bare-challenge grant (older app builds)', async () => {
        const verifier = generateToken();
        const challenge = await s256Challenge(verifier);
        const user = await seedPasswordUser(`leg-${crypto.randomUUID()}@test.dev`, 'password123');
        const grant = await jsonPost('/v1/auth/editor/grant', { challenge }, await tokenFor(user));
        expect(grant.status).toBe(200);
        const { code } = await grant.json<{ code: string }>();

        const res = await jsonPost('/v1/auth/editor/exchange', { code, verifier });
        expect(res.status).toBe(200);
    });

    it('poll and exchange race — exactly one wins', async () => {
        const { attemptId, verifier } = await newAttempt();
        const code = await grantFor(attemptId);

        const [a, b] = await Promise.all([
            jsonPost('/v1/auth/editor/poll', { attempt_id: attemptId, verifier }),
            jsonPost('/v1/auth/editor/exchange', { code, verifier }),
        ]);
        expect([a.status, b.status].sort()).toEqual([200, 400]);
    });

    it('burns the code on a wrong verifier, so it cannot be retried', async () => {
        const { attemptId, verifier } = await newAttempt();
        const code = await grantFor(attemptId);

        const wrong = await jsonPost('/v1/auth/editor/exchange', { code, verifier: generateToken() });
        expect(wrong.status).toBe(400);
        expect(await wrong.json()).toEqual({ error: 'invalid_code' });

        // Correct verifier now too late — the attempt was consumed above.
        const retry = await jsonPost('/v1/auth/editor/exchange', { code, verifier });
        expect(retry.status).toBe(400);
        expect(await retry.json()).toEqual({ error: 'invalid_code' });
    });
});
