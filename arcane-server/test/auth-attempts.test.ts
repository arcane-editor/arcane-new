import { describe, it, expect } from 'vitest';
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
