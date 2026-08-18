-- PROD-ONLY RECONCILIATION — run ONCE against arcane-db (production) immediately
-- before `wrangler d1 migrations apply arcane-db --remote`.
--
-- WHY THIS EXISTS
-- `0008_remove_plans_credits.sql` is recorded as applied in prod's
-- `d1_migrations` table, but none of its statements actually took effect: the
-- production `users` table still carries `plan`, `promo_code`,
-- `promo_expires_at`, and `credits_reset_at`, and the `plans` and
-- `upgrade_requests` tables still exist. (Most likely the D1 SQLite version at
-- the time did not support ALTER TABLE ... DROP COLUMN, and the migration was
-- marked applied regardless.) The dev database never showed this because it was
-- provisioned after that point, so 0008 applied there for real.
--
-- The consequence: `0013_billing.sql` starts with
--     ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
-- which dies on prod with `duplicate column name: plan`, leaving the database
-- half-migrated (0012 applied, 0013 partially applied). Verified by replaying a
-- real `d1 export` of prod into a local D1 on 2026-08-18.
--
-- This script is 0008's body, replayed so the schema matches what the migration
-- history already claims. It is NOT a migration file on purpose: `d1_migrations`
-- already lists 0008 as applied, and adding a new numbered migration would run
-- after 0013 — too late to help.
--
-- SAFETY: `DROP COLUMN plan` discards the legacy plan value. Capture it first:
--     SELECT id, email, plan FROM users WHERE plan <> 'free';
-- 0013 re-creates `plan` with DEFAULT 'free', so any legacy paid user must be
-- restored afterwards (see docs/superpowers/plans/2026-08-18-v03-prod-launch.md).

DROP TABLE IF EXISTS plans;
DROP TABLE IF EXISTS upgrade_requests;

ALTER TABLE users DROP COLUMN plan;
ALTER TABLE users DROP COLUMN promo_code;
ALTER TABLE users DROP COLUMN promo_expires_at;
ALTER TABLE users DROP COLUMN credits_reset_at;
