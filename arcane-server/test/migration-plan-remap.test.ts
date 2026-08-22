import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertSubscription } from '../src/lib/db.ts';

/**
 * Migration 0022 retires the proplus/ultra plan ids, remapping proplus onto
 * pro's new $25 slot and ultra onto max's new $50 slot. All committed
 * migrations (0001..0022) already ran once against this test D1 in
 * test/apply-migrations.ts, BEFORE any proplus/ultra row could exist in this
 * suite — so a fresh migration run can't be used to observe the remap.
 * Instead, this test seeds legacy rows and re-executes 0022's UPDATE
 * statements VERBATIM, proving the SQL text itself performs the remap without
 * re-running migrations mid-suite. Keep this array in sync with
 * migrations/0022_plans_app_config.sql if that file's UPDATEs ever change.
 */
const REMAP_STATEMENTS = [
    "UPDATE users         SET plan = 'pro' WHERE plan = 'proplus'",
    "UPDATE subscriptions SET plan = 'pro' WHERE plan = 'proplus'",
    "UPDATE users         SET plan = 'max' WHERE plan = 'ultra'",
    "UPDATE subscriptions SET plan = 'max' WHERE plan = 'ultra'",
];

async function runRemap(): Promise<void> {
    for (const stmt of REMAP_STATEMENTS) await env.arcane_db.prepare(stmt).run();
}

describe('migration 0022 — plan remap', () => {
    it('remaps a proplus user to pro and an ultra user to max', async () => {
        const proplusUser = await env.arcane_db.prepare(
            "INSERT INTO users (email, password_hash, salt, email_verified, plan) VALUES (?, '', '', 1, 'proplus') RETURNING *"
        ).bind('remap-proplus@test.dev').first<{ id: number }>();
        const ultraUser = await env.arcane_db.prepare(
            "INSERT INTO users (email, password_hash, salt, email_verified, plan) VALUES (?, '', '', 1, 'ultra') RETURNING *"
        ).bind('remap-ultra@test.dev').first<{ id: number }>();

        await runRemap();

        const proplusRow = await env.arcane_db.prepare('SELECT plan FROM users WHERE id = ?')
            .bind(proplusUser!.id).first<{ plan: string }>();
        const ultraRow = await env.arcane_db.prepare('SELECT plan FROM users WHERE id = ?')
            .bind(ultraUser!.id).first<{ plan: string }>();
        expect(proplusRow!.plan).toBe('pro');
        expect(ultraRow!.plan).toBe('max');
    });

    it('remaps subscriptions rows the same way', async () => {
        const user = await env.arcane_db.prepare(
            "INSERT INTO users (email, password_hash, salt, email_verified) VALUES (?, '', '', 1) RETURNING *"
        ).bind('remap-sub@test.dev').first<{ id: number }>();

        await upsertSubscription(env.arcane_db, {
            subscriptionId: 'sub_remap_proplus', userId: user!.id, productId: null,
            plan: 'proplus', status: 'active', currentPeriodEnd: null,
        });
        await upsertSubscription(env.arcane_db, {
            subscriptionId: 'sub_remap_ultra', userId: user!.id, productId: null,
            plan: 'ultra', status: 'active', currentPeriodEnd: null,
        });

        await runRemap();

        const rows = await env.arcane_db.prepare(
            'SELECT dodo_subscription_id, plan FROM subscriptions WHERE dodo_subscription_id IN (?, ?)'
        ).bind('sub_remap_proplus', 'sub_remap_ultra').all<{ dodo_subscription_id: string; plan: string }>();
        const byId = Object.fromEntries(rows.results.map(r => [r.dodo_subscription_id, r.plan]));
        expect(byId['sub_remap_proplus']).toBe('pro');
        expect(byId['sub_remap_ultra']).toBe('max');
    });

    it('does not touch a plan value it does not recognise', async () => {
        const user = await env.arcane_db.prepare(
            "INSERT INTO users (email, password_hash, salt, email_verified, plan) VALUES (?, '', '', 1, 'pro') RETURNING *"
        ).bind('remap-untouched@test.dev').first<{ id: number }>();

        await runRemap();

        const row = await env.arcane_db.prepare('SELECT plan FROM users WHERE id = ?')
            .bind(user!.id).first<{ plan: string }>();
        expect(row!.plan).toBe('pro'); // unaffected — was never proplus/ultra
    });
});
