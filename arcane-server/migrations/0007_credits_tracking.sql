-- Add credits_reset_at to users (effective period boundary after promo expiry / plan changes)
ALTER TABLE users ADD COLUMN credits_reset_at TEXT;

-- Backfill existing users: set to created_at (safe — MAX(old_date, calendarMonthStart) resolves to calendarMonthStart)
UPDATE users SET credits_reset_at = created_at WHERE credits_reset_at IS NULL;

-- Add per-request credits tracking to request_logs for audit
ALTER TABLE request_logs ADD COLUMN credits INTEGER NOT NULL DEFAULT 0;
