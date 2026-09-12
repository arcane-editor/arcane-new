-- Desktop client crash reports (POST /v1/client-error).
--
-- Why a table and not just Workers Logs: logs are the live tail (already on,
-- `[observability]`), but they age out in days. A desktop crash is reported by
-- whoever happens to hit it, days before anyone looks — "how many users hit
-- this on 0.3.2" has to still be answerable next week.
--
-- Every column except `message` is nullable/defaulted on purpose. A crash
-- early in boot may not know its own version yet, and losing that report to a
-- NOT NULL would defeat the whole point.
CREATE TABLE IF NOT EXISTS client_errors (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    kind            TEXT    NOT NULL DEFAULT 'unknown',
    message         TEXT    NOT NULL,
    stack           TEXT    NOT NULL DEFAULT '',
    component_stack TEXT    NOT NULL DEFAULT '',
    app_version     TEXT    NOT NULL DEFAULT '',
    channel         TEXT    NOT NULL DEFAULT '',
    os              TEXT    NOT NULL DEFAULT '',
    session_id      TEXT    NOT NULL DEFAULT '',
    -- NULL for the signed-out crash, which is the case this endpoint exists
    -- for: the AI panel's `!loggedIn` render path can throw before any token.
    user_id         TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- The only access pattern: newest first, for the admin listing.
CREATE INDEX IF NOT EXISTS idx_client_errors_created_at ON client_errors(created_at DESC);
