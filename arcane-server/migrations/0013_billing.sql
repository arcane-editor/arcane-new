-- Billing: subscription plan + credit balances on users, plus subscription and
-- webhook-idempotency tables. Credits are stored in integer MICRO-USD of
-- estimated model cost (1 USD = 1,000,000 micro; 1 credit = $0.01 = 10,000
-- micro) so accounting never touches floats. Two buckets: plan_credits_micro
-- resets each billing period; topup_credits_micro persists until spent. Debit
-- order is plan-first, then top-up (see debitCredits in src/lib/db.ts).
--
-- NOTE (prod cutover): ADD COLUMN is NOT idempotent — a partial failure must be
-- reconciled by hand, never blind re-run. See the auth 0012 precedent.

ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE users ADD COLUMN plan_credits_micro INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN topup_credits_micro INTEGER NOT NULL DEFAULT 0;
-- ISO-8601 UTC (…Z) string, comparable to new Date().toISOString(); NULL means
-- "never anchored" → the first AI request refreshes the free cycle.
ALTER TABLE users ADD COLUMN plan_period_end TEXT;
ALTER TABLE users ADD COLUMN dodo_customer_id TEXT;

-- Grandfather every existing user onto the free tier's monthly grant so active
-- testers keep working immediately. 150 credits × 10,000 micro = 1,500,000.
-- plan_period_end stays NULL → first AI call sets the cycle anchor (the free
-- reset SETs the amount, it never adds, so this is not double-granted).
UPDATE users SET plan_credits_micro = 1500000 WHERE plan_credits_micro = 0;

-- One row per Dodo subscription. Credits for paid plans are granted only by
-- webhooks (subscription.active / renewed); the lazy monthly reset applies to
-- the free tier alone, so a failed renewal can never regrant paid credits.
CREATE TABLE IF NOT EXISTS subscriptions (
    dodo_subscription_id TEXT    PRIMARY KEY,
    user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id           TEXT,
    plan                 TEXT    NOT NULL,
    status               TEXT    NOT NULL,   -- active | on_hold | cancelled | failed
    current_period_end   TEXT,
    created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);

-- Webhook idempotency ledger: Standard-Webhooks delivers at-least-once, so we
-- dedup on the provider's webhook-id before applying any effect.
CREATE TABLE IF NOT EXISTS billing_events (
    webhook_id  TEXT PRIMARY KEY,
    type        TEXT,
    received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
