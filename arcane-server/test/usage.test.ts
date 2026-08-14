import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { recordUsage } from '../src/lib/usage.ts';
import { estimateCost } from '../src/lib/costs.ts';
import { getCurrentPeriodStart, getUserBillingRow } from '../src/lib/db.ts';
import { usdToMicro } from '../src/config/tiers.ts';
import { seedPasswordUser } from './helpers.ts';

// recordUsage is the shared metering path for ALL four AI routes. The test env
// has no AI binding, so we exercise the helper directly against the test D1
// (this is what each route calls after its model response).

describe('recordUsage', () => {
    it('appends a request_logs row with catalog-derived cost', async () => {
        const user = await seedPasswordUser('usage-log@test.dev', 'password123');
        const inTok = 12_000, outTok = 800;
        const model = '@cf/moonshotai/kimi-k2.7-code';

        await recordUsage(env.arcane_db, user.id, model, inTok, outTok, 1234, { taskType: 'unit_test' });

        const row = await env.arcane_db.prepare(
            'SELECT * FROM request_logs WHERE user_id = ? ORDER BY id DESC LIMIT 1'
        ).bind(user.id).first<{ model: string; input_tokens: number; output_tokens: number; cost_usd: number; duration_ms: number; task_type: string }>();

        expect(row).not.toBeNull();
        expect(row!.model).toBe(model);
        expect(row!.input_tokens).toBe(inTok);
        expect(row!.output_tokens).toBe(outTok);
        expect(row!.duration_ms).toBe(1234);
        expect(row!.task_type).toBe('unit_test');
        expect(row!.cost_usd).toBeCloseTo(estimateCost(model, inTok, outTok), 9);
    });

    it('meters embeddings at non-zero cost (bge-small now in catalog)', async () => {
        const user = await seedPasswordUser('usage-embed@test.dev', 'password123');
        await recordUsage(env.arcane_db, user.id, '@cf/baai/bge-small-en-v1.5', 5_000, 0, 42, { taskType: 'embeddings' });

        const row = await env.arcane_db.prepare(
            'SELECT cost_usd FROM request_logs WHERE user_id = ? ORDER BY id DESC LIMIT 1'
        ).bind(user.id).first<{ cost_usd: number }>();
        expect(row!.cost_usd).toBeGreaterThan(0);
    });

    it('accumulates the monthly usage_periods rollup across calls', async () => {
        const user = await seedPasswordUser('usage-rollup@test.dev', 'password123');
        const model = '@cf/zai-org/glm-5.2';
        await recordUsage(env.arcane_db, user.id, model, 1_000, 200, 10);
        await recordUsage(env.arcane_db, user.id, model, 3_000, 400, 10);

        const period = await env.arcane_db.prepare(
            'SELECT * FROM usage_periods WHERE user_id = ? AND period_start = ?'
        ).bind(user.id, getCurrentPeriodStart()).first<{ total_input_tokens: number; total_output_tokens: number; total_requests: number; total_cost_usd: number }>();

        expect(period).not.toBeNull();
        expect(period!.total_input_tokens).toBe(4_000);
        expect(period!.total_output_tokens).toBe(600);
        expect(period!.total_requests).toBe(2);
        const expected = estimateCost(model, 1_000, 200) + estimateCost(model, 3_000, 400);
        expect(period!.total_cost_usd).toBeCloseTo(expected, 9);
    });

    it('debits the request cost from the credit balance', async () => {
        const user = await seedPasswordUser('usage-debit@test.dev', 'password123');
        await env.arcane_db.prepare(
            "UPDATE users SET plan = 'pro', plan_credits_micro = ?, plan_period_end = '2099-01-01T00:00:00.000Z' WHERE id = ?"
        ).bind(5_000_000, user.id).run();

        const model = '@cf/moonshotai/kimi-k2.7-code';
        const inTok = 20_000, outTok = 1_000;
        await recordUsage(env.arcane_db, user.id, model, inTok, outTok, 10);

        const r = await getUserBillingRow(env.arcane_db, user.id);
        expect(r!.plan_credits_micro).toBe(5_000_000 - usdToMicro(estimateCost(model, inTok, outTok)));
    });

    it('skipDebit meters tokens without touching the credit balance', async () => {
        const user = await seedPasswordUser('skipdebit@test.dev', 'password123');
        await env.arcane_db.prepare('UPDATE users SET plan_credits_micro = 500000 WHERE id = ?')
            .bind(user.id).run();

        await recordUsage(env.arcane_db, user.id, '@cf/qwen/qwen2.5-coder-32b-instruct',
            1000, 100, 50, { taskType: 'inline', skipDebit: true });

        const bal = await env.arcane_db.prepare('SELECT plan_credits_micro FROM users WHERE id = ?')
            .bind(user.id).first<{ plan_credits_micro: number }>();
        expect(bal?.plan_credits_micro).toBe(500000); // untouched

        const log = await env.arcane_db.prepare(
            'SELECT task_type, input_tokens FROM request_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1'
        ).bind(user.id).first<{ task_type: string; input_tokens: number }>();
        expect(log).toMatchObject({ task_type: 'inline', input_tokens: 1000 }); // still metered
    });

    it('fallbackModel lands in request_logs.fallback_model', async () => {
        const user = await seedPasswordUser('fbmodel@test.dev', 'password123');
        await recordUsage(env.arcane_db, user.id, '@cf/qwen/qwen2.5-coder-32b-instruct',
            10, 10, 5, { fallbackModel: '@cf/qwen/qwen2.5-coder-32b-instruct' });
        const log = await env.arcane_db.prepare(
            'SELECT fallback_model FROM request_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1'
        ).bind(user.id).first<{ fallback_model: string | null }>();
        expect(log?.fallback_model).toBe('@cf/qwen/qwen2.5-coder-32b-instruct');
    });
});

import { billedMicro } from '../src/lib/usage.ts';

describe('billedMicro', () => {
    it('applies gateway fee and margin to the list cost', () => {
        // glm-5.2, 10k fresh + 20k cached + 2k out = $0.028 list
        // 0.028 * 1.05 * 2.0 = $0.0588 -> 58800 micro
        expect(billedMicro('@cf/zai-org/glm-5.2', 30_000, 2_000, 20_000)).toBe(58_800);
    });

    it('rounds to an integer micro-USD', () => {
        const micro = billedMicro('openai/gpt-5.6-luna', 8_000, 800, 0);
        expect(Number.isInteger(micro)).toBe(true);
        // 0.00256 * 2.10 = 0.005376 -> 5376
        expect(micro).toBe(5_376);
    });

    it('is 0 for an unknown model so it is never debited', () => {
        expect(billedMicro('nope/nope', 1_000, 1_000, 0)).toBe(0);
    });

    it('charges long-context rates above the cliff', () => {
        const below = billedMicro('xai/grok-4.6', 200_000, 1_000, 0);
        const above = billedMicro('xai/grok-4.6', 200_001, 1_000, 0);
        expect(above).toBeGreaterThan(below * 1.9);
    });
});
