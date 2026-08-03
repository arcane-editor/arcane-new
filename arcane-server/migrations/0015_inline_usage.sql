-- Per-user daily counter for inline (tab) completions. Allowance model, not
-- credits: inline requests are free but capped per plan per UTC day (spec
-- 2026-08-03). One O(1) upsert per request; rejected requests still bump the
-- counter (harmless — it only gates, it is not billing).
CREATE TABLE IF NOT EXISTS inline_usage (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    usage_date TEXT    NOT NULL,   -- UTC day, 'YYYY-MM-DD'
    count      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, usage_date)
);
