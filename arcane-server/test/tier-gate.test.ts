import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { isTierAllowed } from '../src/config/tiers.ts';
import { getIntensityConfig } from '../src/config/plans.ts';
import { seedPasswordUser, tokenFor } from './helpers.ts';
import { clearConfigCache, putConfigDoc } from '../src/lib/app-config.ts';
import type { ModelRoutingDoc } from '../src/lib/app-config.ts';

// DEFAULT_MODEL_ROUTING's high tier executor is SPARK_MODEL (Task 4), whose
// 'direct' route calls a real OpenAI-compatible endpoint — the test env now
// has valid-shaped SPARK_BASE_URL/SPARK_API_KEY (wrangler.test.toml), so an
// unmocked streamText for that model attempts REAL network egress (to the
// RFC-2606 spark.invalid host), which is noisy in this sandboxed runner even
// though it still ultimately errors. The "easy"/absent test below only cares
// that both stay on the tier's plain executor (as opposed to executorHard,
// covered by the 'hard' test above) — not that the executor specifically is
// spark — so route it at a '@cf/...' id instead, which fails synchronously
// (no AI binding in the test env) with zero network I/O, same as every other
// model exercised in this describe block.
const CF_ONLY_ROUTING: ModelRoutingDoc = {
    tiers: {
        low: { planner: '@cf/zai-org/glm-5.2', executor: '@cf/zai-org/glm-5.2' },
        mid: { planner: '@cf/zai-org/glm-5.2', executor: '@cf/zai-org/glm-5.2' },
        high: { planner: '@cf/zai-org/glm-5.2', executor: '@cf/zai-org/glm-5.2', executorHard: 'xai/grok-4.6' },
    },
    inline: '@cf/qwen/qwen3-30b-a3b-fp8',
};

/** app_config state persists across `it()`s within one test file — restore
 *  "no row" so any later test in this file keeps seeing DEFAULT_MODEL_ROUTING. */
async function resetModelRouting(): Promise<void> {
    await env.arcane_db.prepare("DELETE FROM app_config WHERE key = 'model_routing'").run();
    clearConfigCache();
}

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
// real chat route (config/routing.ts against a routing doc; the 'hard' test
// below seeds no model_routing row, so DEFAULT_MODEL_ROUTING applies — the
// 'easy'/absent test seeds CF_ONLY_ROUTING instead, see its comment). The test
// env has no AI binding, so a '@cf/...' resolution 500s synchronously with no
// network I/O — but body.model is already committed to the request_logs row
// (chat.ts's finally) by the time that happens, exactly like
// chat-metering.test.ts's error-lane pattern.
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

    it('"easy" and absent difficulty both stay on the tier executor (not executorHard)', async () => {
        const user = await seedMaxUser('tier-easy@test.dev');
        const token = await tokenFor(user);

        await putConfigDoc(env.arcane_db, 'model_routing', CF_ONLY_ROUTING);
        try {
            expect((await postChat(token, 'easy')).status).toBe(500);
            expect((await postChat(token)).status).toBe(500);

            const rows = await env.arcane_db.prepare(
                'SELECT model FROM request_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 2'
            ).bind(user.id).all<{ model: string }>();
            expect(rows.results).toHaveLength(2);
            expect(rows.results.every(r => r.model === CF_ONLY_ROUTING.tiers.high.executor)).toBe(true);
        } finally {
            await resetModelRouting();
        }
    });
});
