import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { seedPasswordUser, tokenFor } from './helpers.ts';

// P0 fix wave 2026-08-16: the non-streaming lane's `if (event.type ===
// 'error') throw` used to jump past logUsage entirely — a provider-error
// request produced NO request_logs row at all, invisible to the $1/hr
// anti-abuse cap. Metering now runs in a finally on both lanes.
describe('chat metering on the error lane', () => {
    it('a non-streaming request that errors still writes a request_logs row', async () => {
        const user = await seedPasswordUser('meter-err@test.dev', 'password123');
        await env.arcane_db.prepare(
            "UPDATE users SET plan = 'pro', plan_credits_micro = 5000000, plan_period_end = '2099-01-01T00:00:00.000Z' WHERE id = ?"
        ).bind(user.id).run();
        const token = await tokenFor(user);

        const res = await SELF.fetch('https://example.com/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'auto', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
        });

        // The test env has no AI binding, so the provider call fails — the
        // request 500s, but the metering row must exist regardless.
        expect(res.status).toBe(500);
        const row = await env.arcane_db.prepare(
            'SELECT COUNT(*) AS n FROM request_logs WHERE user_id = ?'
        ).bind(user.id).first<{ n: number }>();
        expect(row!.n).toBe(1);
    });
});
