-- Remove plans, promo codes, and credits system
-- Keep request_logs and usage_periods for token tracking

-- Drop unused tables
DROP TABLE IF EXISTS plans;
DROP TABLE IF EXISTS upgrade_requests;

-- Remove plan/promo columns from users (D1 supports DROP COLUMN)
ALTER TABLE users DROP COLUMN plan;
ALTER TABLE users DROP COLUMN promo_code;
ALTER TABLE users DROP COLUMN promo_expires_at;
ALTER TABLE users DROP COLUMN credits_reset_at;
