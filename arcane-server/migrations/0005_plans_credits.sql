-- Add credits tracking to usage_periods
ALTER TABLE usage_periods ADD COLUMN total_credits INTEGER NOT NULL DEFAULT 0;

-- Update plans table to match new config (for reference/admin)
DELETE FROM plans;
INSERT INTO plans (name, credit_limit_usd, description) VALUES
    ('free',  0,   'Free — 50 credits/month'),
    ('pro',   15,  'Pro — 2,000 credits/month'),
    ('power', 50,  'Power — 8,000 credits/month'),
    ('prime', 100, 'Prime — 20,000 credits/month');

-- Migrate users from old plan names
UPDATE users SET plan = 'prime' WHERE plan = 'ultra';
