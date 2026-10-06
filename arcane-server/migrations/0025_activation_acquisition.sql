-- First-party activation milestones. Existing install reporting and Reddit
-- conversions are unchanged. Legacy installs enroll on their next updated run.
CREATE TABLE install_activations (
    install_id TEXT PRIMARY KEY,
    proof_hash TEXT NOT NULL,
    os TEXT NOT NULL,
    app_version TEXT NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('release', 'dev')),
    registered_at TEXT NOT NULL DEFAULT (datetime('now')),
    activated_at TEXT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    associated_at TEXT
);
CREATE INDEX install_activations_user ON install_activations(user_id, activated_at);
CREATE INDEX install_activations_date ON install_activations(channel, activated_at);

-- One validated acquisition record per newly created account. Missing is
-- unattributed, never implicitly organic. No query strings or project data.
CREATE TABLE user_acquisition (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    medium TEXT NOT NULL,
    landing_path TEXT NOT NULL,
    referrer_host TEXT,
    captured_at TEXT NOT NULL DEFAULT (datetime('now'))
);
