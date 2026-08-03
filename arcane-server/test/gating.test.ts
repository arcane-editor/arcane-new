import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { seedPasswordUser, tokenFor } from './helpers.ts';

const AI_PATHS = ['/v1/chat/completions', '/v1/embeddings', '/v1/graph/enrich', '/v1/unity/search', '/v1/completions/inline'];

describe('requireVerifiedEmail on AI routes', () => {
    it('403 email_unverified for unverified users on every AI path', async () => {
        const user = await seedPasswordUser('gate-u@test.dev', 'password123', { verified: false });
        const token = await tokenFor(user);
        for (const path of AI_PATHS) {
            const res = await SELF.fetch(`https://example.com${path}`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            expect(res.status, path).toBe(403);
            expect(await res.json(), path).toEqual({ error: 'email_unverified' });
        }
    });

    it('verified users pass the gate (handler may still fail on absent AI bindings)', async () => {
        const user = await seedPasswordUser('gate-v@test.dev', 'password123');
        const token = await tokenFor(user);
        const res = await SELF.fetch('https://example.com/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'x', messages: [] }),
        });
        // Gate passed: anything but the two auth-gate statuses. The test env
        // has no AI binding, so the handler itself may 4xx/500 — that's fine.
        expect([401, 403]).not.toContain(res.status);
    });
});
