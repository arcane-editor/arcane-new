-- Feedback table (public submissions from landing page)
CREATE TABLE IF NOT EXISTS feedback (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    message    TEXT    NOT NULL DEFAULT '',
    email      TEXT    NOT NULL DEFAULT '',
    category   TEXT    NOT NULL DEFAULT 'general',
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
