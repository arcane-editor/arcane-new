-- Fallback observability: when an external provider (MiniMax/Moonshot) fails
-- before first token and a CF-catalog model serves instead, `model` records
-- the ACTUAL serving model and `fallback_model` is set to it (non-null ⇒
-- fallback happened). NOTE: ADD COLUMN is not idempotent (see 0013 header).
ALTER TABLE request_logs ADD COLUMN fallback_model TEXT;
