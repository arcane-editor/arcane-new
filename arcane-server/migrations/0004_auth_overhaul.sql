-- Add role column to users table (admin role set via direct SQL only)
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';

-- Device codes for IDE <-> Web auth linking (device auth flow)
CREATE TABLE IF NOT EXISTS device_codes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    device_code   TEXT    NOT NULL UNIQUE,
    user_code     TEXT    NOT NULL UNIQUE,
    user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
    status        TEXT    NOT NULL DEFAULT 'pending',
    expires_at    TEXT    NOT NULL,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_device_codes_user_code ON device_codes(user_code);
CREATE INDEX IF NOT EXISTS idx_device_codes_device_code ON device_codes(device_code);

-- Plan upgrade requests (submitted from IDE, reviewed by admin)
CREATE TABLE IF NOT EXISTS upgrade_requests (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    current_plan    TEXT    NOT NULL,
    requested_plan  TEXT    NOT NULL,
    status          TEXT    NOT NULL DEFAULT 'pending',
    admin_note      TEXT    NOT NULL DEFAULT '',
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    resolved_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_upgrade_requests_user ON upgrade_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_upgrade_requests_status ON upgrade_requests(status);
