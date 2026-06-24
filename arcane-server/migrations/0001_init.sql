-- Plans table (billing tiers)
CREATE TABLE IF NOT EXISTS plans (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL UNIQUE,
    credit_limit_usd REAL    NOT NULL,
    description      TEXT    NOT NULL DEFAULT '',
    allowed_models   TEXT    NOT NULL DEFAULT '[]'
);

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    salt          TEXT    NOT NULL,
    plan          TEXT    NOT NULL DEFAULT 'free',
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Usage periods table (monthly cost tracking)
CREATE TABLE IF NOT EXISTS usage_periods (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    period_start        TEXT    NOT NULL,
    period_end          TEXT    NOT NULL,
    total_input_tokens  INTEGER NOT NULL DEFAULT 0,
    total_output_tokens INTEGER NOT NULL DEFAULT 0,
    total_cost_usd      REAL    NOT NULL DEFAULT 0,
    total_requests      INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, period_start)
);

-- Request logs table (per-request audit trail)
CREATE TABLE IF NOT EXISTS request_logs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    model         TEXT    NOT NULL,
    input_tokens  INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_usd      REAL    NOT NULL,
    duration_ms   INTEGER NOT NULL,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_request_logs_user_date ON request_logs(user_id, created_at DESC);
