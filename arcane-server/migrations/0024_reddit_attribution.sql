-- Reddit Ads attribution + Conversions API reporting.
--
-- Three pieces, one purpose: know which accounts and installs came from a
-- Reddit ad, and have a durable record of what we told Reddit about them.

-- Where an account came from. Captured by the website in a first-party cookie
-- (the Reddit pixel never runs on /auth) and handed over at signup, so it is
-- NULL for every organic account and every account that predates this.
--
-- Kept on the user rather than written once into an events table because it
-- outlives the signup: a Purchase weeks later still has to be reported against
-- the click that originally won the user.
ALTER TABLE users ADD COLUMN rdt_click_id TEXT;
ALTER TABLE users ADD COLUMN rdt_uuid TEXT;

-- One row per desktop install that has ever phoned home (POST /v1/install).
--
-- The PRIMARY KEY is doing real work: it is the idempotency guard. The app
-- reports its first run once and then records that it did, but a reinstall, a
-- restored home directory, or a lost flag file would report again — and a
-- duplicate Install conversion trains the ad optimizer on a user who does not
-- exist. INSERT OR IGNORE against this key makes the second report a no-op.
CREATE TABLE IF NOT EXISTS app_installs (
    install_id  TEXT PRIMARY KEY,
    os          TEXT NOT NULL DEFAULT '',
    app_version TEXT NOT NULL DEFAULT '',
    channel     TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Audit trail for every Conversions API attempt, including the ones that
-- failed or were skipped.
--
-- Reddit is not a system of record and we do not retry into it indefinitely,
-- so this table IS the record: when the campaign numbers look wrong, the
-- question is always "did we send it, and what did Reddit say", and without
-- this the only answer available is a log line that aged out.
--
-- It is also the upgrade path. If `status='failed'` ever stops being rare,
-- a cron drain can be added that reads exactly these rows — the schema is
-- already the queue, without today having to run one.
CREATE TABLE IF NOT EXISTS reddit_conversions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 'SignUp' | 'Purchase' | 'Install' — what we called it to Reddit.
    event_name    TEXT    NOT NULL,
    -- Our idempotency key for the event, echoed to Reddit so a retry of the
    -- same conversion collapses instead of double-counting.
    conversion_id TEXT    NOT NULL UNIQUE,
    -- Whichever identifies the subject. Both NULL is legal (an install that
    -- never signed in has only its install_id, held below).
    user_id       INTEGER,
    install_id    TEXT,
    -- Stored unhashed: this is Reddit's own opaque click token, not PII, and
    -- keeping it readable is what makes a mis-attribution debuggable.
    click_id      TEXT,
    -- 'ok' | 'failed' | 'skipped'. 'skipped' means the integration was not
    -- configured (no token) — recorded rather than dropped, so a silently
    -- unconfigured production Worker is visible instead of merely quiet.
    status        TEXT    NOT NULL,
    http_status   INTEGER,
    error         TEXT,
    -- 1 on the dev worker, whose events Reddit accepts but does not count.
    test_mode     INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- The two questions asked of this table: "what went wrong lately" (admin
-- listing, newest first) and "did we already report this user's signup".
CREATE INDEX IF NOT EXISTS idx_reddit_conversions_created_at
    ON reddit_conversions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reddit_conversions_user_event
    ON reddit_conversions(user_id, event_name);
