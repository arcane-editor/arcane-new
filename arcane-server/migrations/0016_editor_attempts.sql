-- Editor login attempts. Replaces device_codes with a PKCE-BOUND record:
-- every attempt carries its S256 challenge from the moment it is created, so
-- all three delivery channels (custom-scheme deep link, 127.0.0.1 loopback,
-- and the new poll endpoint) converge on ONE atomic single-use consume — the
-- `consumed_at IS NULL` predicate already proven by consumeAuthToken in
-- src/lib/db.ts.
--
-- Why this replaces device_codes: that flow had no PKCE binding at all. Its
-- user code was 8 characters from a 32-character alphabet, guarded only by a
-- rate limit, and it was a second login path to harden forever. The poll
-- channel supersedes it with the same cryptographic binding as the deep link.
--
-- device_codes is dropped separately in 0017, together with the code that
-- reads it — a table cannot be dropped before its last reader is gone.

CREATE TABLE IF NOT EXISTS editor_attempts (
    -- Server-generated UUID; the only identifier that ever reaches the browser.
    attempt_id  TEXT PRIMARY KEY,
    -- PKCE S256 challenge, base64url 43-128 chars. Bound at creation so the
    -- verifier that redeems this attempt can never be swapped.
    challenge   TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',   -- pending | authorized
    -- NULL until the website authorizes the attempt for a signed-in user.
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
    -- SHA-256 hex of the one-time grant code. The raw code is handed out once
    -- and never stored, matching the auth_tokens convention.
    code_hash   TEXT,
    -- The grant code keeps its own, much shorter life (60s) than the attempt
    -- that carries it. The attempt must survive ~10 minutes so the app can go
    -- on polling, but the code travels in a browser-visible callback URL and
    -- should stop being redeemable almost immediately. Both are PKCE-bound and
    -- useless without the verifier; this is defence in depth, and it preserves
    -- the 60s TTL the pre-0016 auth_tokens flow already had.
    code_expires_at TEXT,
    consumed_at TEXT,
    -- Attempt lifetime: bounds the poll channel.
    expires_at  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Opportunistic cleanup scans by expiry; the exchange path looks up by code.
CREATE INDEX IF NOT EXISTS idx_editor_attempts_expires ON editor_attempts(expires_at);
CREATE INDEX IF NOT EXISTS idx_editor_attempts_code    ON editor_attempts(code_hash);
