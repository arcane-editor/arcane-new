import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { isTierAllowed } from '../src/config/tiers.ts';
import { getIntensityConfig, SPARK_MODEL } from '../src/config/plans.ts';
import { seedPasswordUser, tokenFor } from './helpers.ts';

// The gate is pure policy — exercised here directly so it is covered even
// though the test env has no AI binding for a full chat round-trip.
describe('tier gate policy', () => {
    it('blocks free users from Deep Think and Max', () => {
        expect(isTierAllowed('free', 'mid')).toBe(false);
        expect(isTierAllowed('free', 'high')).toBe(false);
    });

    it('lets free users use Standard', () => {
        expect(isTierAllowed('free', 'low')).toBe(true);
    });

    it('resolves the tier before gating so super is gated as high', () => {
        const cfg = getIntensityConfig('super');
        expect(cfg?.label).toBe('Max');
        expect(isTierAllowed('free', 'super')).toBe(false);
        expect(isTierAllowed('max', 'super')).toBe(true);
    });

    // Per-plan matrix for the new ladder: starter is low-only (same as free);
    // pro gets Deep Think but not Max; max gets everything. This only pins
    // entitlement — model choice for an allowed tier is config/routing.ts's job
    // (see the difficulty-routing integration tests below).
    it('starter is low-only', () => {
        expect(isTierAllowed('starter', 'low')).toBe(true);
        expect(isTierAllowed('starter', 'mid')).toBe(false);
        expect(isTierAllowed('starter', 'high')).toBe(false);
    });

    it('pro gets Deep Think but not Max', () => {
        expect(isTierAllowed('pro', 'low')).toBe(true);
        expect(isTierAllowed('pro', 'mid')).toBe(true);
        expect(isTierAllowed('pro', 'high')).toBe(false);
    });

    it('max gets every tier', () => {
        expect(isTierAllowed('max', 'low')).toBe(true);
        expect(isTierAllowed('max', 'mid')).toBe(true);
        expect(isTierAllowed('max', 'high')).toBe(true);
    });

    it('reaching high/super needs max — pro is not enough', () => {
        expect(isTierAllowed('pro', 'high')).toBe(false);
        expect(isTierAllowed('pro', 'super')).toBe(false);
        expect(isTierAllowed('max', 'super')).toBe(true);
    });
});

// Model choice for an entitled ('high') request — integration through the
// real chat route (config/routing.ts against the code-default routing doc;
// no model_routing row is seeded, so DEFAULT_MODEL_ROUTING applies). The test
// env has no AI binding, so the resolved model is served to the provider call
// and then the request 500s — but body.model is already committed to the
// request_logs row (chat.ts's finally) by the time that happens, exactly
// like chat-metering.test.ts's error-lane pattern.
describe('max-plan difficulty routing (through the chat route)', () => {
    async function seedMaxUser(email: string) {
        const user = await seedPasswordUser(email, 'password123');
        await env.arcane_db.prepare(
            "UPDATE users SET plan = 'max', plan_credits_micro = 5000000, plan_period_end = '2099-01-01T00:00:00.000Z' WHERE id = ?"
        ).bind(user.id).run();
        return user;
    }

    async function postChat(token: string, difficulty?: 'easy' | 'hard') {
        return SELF.fetch('https://example.com/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'auto',
                stream: false,
                messages: [{ role: 'user', content: 'hi' }],
                metadata: { reasoningLevel: 'high', ...(difficulty ? { difficulty } : {}) },
            }),
        });
    }

    it('difficulty "hard" routes to executorHard (xai/grok-4.6)', async () => {
        const user = await seedMaxUser('tier-hard@test.dev');
        const token = await tokenFor(user);

        const res = await postChat(token, 'hard');
        expect(res.status).toBe(500); // no AI binding in the test env

        const row = await env.arcane_db.prepare(
            'SELECT model FROM request_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1'
        ).bind(user.id).first<{ model: string }>();
        expect(row?.model).toBe('xai/grok-4.6');
    });

    it('"easy" and absent difficulty both stay on the tier executor (spark)', async () => {
        const user = await seedMaxUser('tier-easy@test.dev');
        const token = await tokenFor(user);

        expect((await postChat(token, 'easy')).status).toBe(500);
        expect((await postChat(token)).status).toBe(500);

        const rows = await env.arcane_db.prepare(
            'SELECT model FROM request_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 2'
        ).bind(user.id).all<{ model: string }>();
        expect(rows.results).toHaveLength(2);
        expect(rows.results.every(r => r.model === SPARK_MODEL)).toBe(true);
    });
});
