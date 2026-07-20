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
});
