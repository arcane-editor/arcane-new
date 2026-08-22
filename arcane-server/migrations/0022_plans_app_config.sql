-- New tier ladder (free/starter/pro/max) + admin-editable runtime AI config.

CREATE TABLE IF NOT EXISTS app_config (
    key        TEXT PRIMARY KEY,     -- 'model_routing' | 'model_pricing'
    value      TEXT NOT NULL,        -- JSON document
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Plan remap: proplus and the old $200 ultra disappear. pro keeps its id at
-- the new $25 slot. Only real paid row in prod is the owner's comped id-5 'pro'.
-- Balances deliberately untouched.
UPDATE users         SET plan = 'pro' WHERE plan = 'proplus';
UPDATE subscriptions SET plan = 'pro' WHERE plan = 'proplus';
UPDATE users         SET plan = 'max' WHERE plan = 'ultra';
UPDATE subscriptions SET plan = 'max' WHERE plan = 'ultra';

-- NO free-user regrant: existing free users keep their current balance. The
-- one-time signup trial applies only to rows created after this deploy
-- (code-side INSERT in src/lib/db.ts).
