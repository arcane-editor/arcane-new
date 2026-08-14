-- Monthly inline (tab) completion spend, in integer micro-USD of REAL cost
-- (no margin — inline is free to the user). A daily request-count cap cannot
-- bound cost because cost scales with FIM context size, so this is the hard
-- backstop that does.
CREATE TABLE IF NOT EXISTS inline_spend (
    user_id     INTEGER NOT NULL,
    month_key   TEXT    NOT NULL,  -- 'YYYY-MM', UTC
    spend_micro INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, month_key)
);

CREATE INDEX IF NOT EXISTS idx_inline_spend_month ON inline_spend(month_key);
