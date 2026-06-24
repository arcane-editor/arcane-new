-- Add promo code tracking columns to users table
ALTER TABLE users ADD COLUMN promo_code TEXT;
ALTER TABLE users ADD COLUMN promo_expires_at TEXT;
