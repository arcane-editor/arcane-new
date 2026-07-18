-- Google OAuth account linking (NULL for password-only users). The partial
-- unique index enforces one account per Google subject without penalizing
-- the common NULL case.
ALTER TABLE users ADD COLUMN google_sub TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL;

-- Email verification. Existing users are grandfathered to verified — they
-- signed up before verification existed and several are active testers.
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
UPDATE users SET email_verified = 1;

-- Session revocation epoch. JWTs carry token_version; a mismatch means the
-- token was revoked (password reset/change). Legacy JWTs without the claim
-- are treated as version 0 — matching this default, so existing 30-day
-- tokens keep working.
ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;

-- One-time secrets: email verification, password reset, web login handoff
-- codes, editor login codes. Raw tokens are never stored — SHA-256 hex only.
-- Single-use is enforced by an atomic consume UPDATE on consumed_at.
CREATE TABLE IF NOT EXISTS auth_tokens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose     TEXT    NOT NULL,  -- verify_email | password_reset | web_login | editor_login
    token_hash  TEXT    NOT NULL UNIQUE,
    meta        TEXT,              -- purpose-specific JSON (editor_login: {"challenge":"..."})
    expires_at  TEXT    NOT NULL,
    consumed_at TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id, purpose, created_at);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires ON auth_tokens(expires_at);
